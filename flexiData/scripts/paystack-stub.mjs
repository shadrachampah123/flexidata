/**
 * Local stand-in for the Paystack API, for automated E2E testing.
 *
 * WHY THIS EXISTS
 * ---------------
 * Paystack's hosted checkout page (checkout.paystack.com) sits behind a WAF
 * that blocks datacenter / CI networks — GitHub Actions runners get HTTP 403,
 * so browser automation cannot complete a test-card payment there. The REAL
 * Paystack TEST API (api.paystack.co) works fine from CI, and is used
 * directly by the E2E for initialization, verification and webhook signing.
 * For the parts that only a human browser can do (actually "paying" on the
 * hosted page), this stub emulates the exact API surface FlexiData consumes:
 *
 *   POST /transaction/initialize
 *   GET  /transaction/verify/:ref
 *   GET  /checkout/<ref>?access_code=…   (the page the auth URL points at)
 *   GET  /bank?type=mobile_money|nuban   (Ghana bank / mobile-money codes)
 *   POST /transferrecipient              (create recipient → RCP_ code)
 *   POST /transfer                       (initiate transfer → TRF_ code)
 *   GET  /transfer/:code                 (fetch transfer status)
 *
 * and a tiny control API for the test script:
 *   POST /_stub/scenario   { ref, scenario, failBefore? }
 *   POST /_stub/transfer-scenario { reference, scenario }
 *   POST /_stub/reset
 *   GET  /_stub/audit      (what the app called, with auth-header SHAPE only,
 *                           plus the callback_url / channels / metadata the app
 *                           sent to initialize — never any key material)
 *   GET  /_stub/health
 *
 * Scenarios per transaction reference (what `verify` reports):
 *   (unset)              -> "ongoing"          (initialized, not paid yet)
 *   "pending"            -> "ongoing"
 *   "success"            -> "success" with the EXACT initialized amount+currency
 *   "success-wrong-amount"   -> "success" with amount + 500 subunits
 *   "success-wrong-currency" -> "success" with currency "NGN"
 *   "failed"             -> "failed"           (e.g. declined card)
 *   "abandoned"          -> "abandoned"        (customer closed checkout)
 *   "flip-success"       -> "failed" for the first `failBefore` verify calls
 *                             (default 1), then "success" — customer retries
 *                             inside the same checkout and pays.
 *
 * SAFETY
 * ------
 *  - Binds to 127.0.0.1 ONLY. It never talks to the real Paystack.
 *  - The app's `Authorization: Bearer <secret key>` header is NEVER logged or
 *    stored — the audit trail records only a boolean
 *    (`authLooksLikeTestKey`) proving the app sent a sk_test_-shaped bearer
 *    header. No key material ever appears in stub logs or responses.
 *
 * Run: node scripts/paystack-stub.mjs   (PAYSTACK_STUB_PORT, default 4599)
 */
import http from "node:http";

const PORT = Number(process.env.PAYSTACK_STUB_PORT ?? 4599);
const HOST = "127.0.0.1";

/** ref -> { amount, currency, email, accessCode, scenario, failBefore, verifyCalls, transactionId } */
const refs = new Map();
const audit = [];
let nextTransactionId = 8_000_000;
let nextAccessCode = 1_000_000;

/**
 * Phase B transfer state.
 * recipients: code -> { type, name, accountNumber, bankCode, currency }
 * transfers: transferCode -> { reference, amount, currency, recipientCode, scenario }
 * transferByRef: reference -> transferCode (Paystack enforces unique references)
 */
const recipients = new Map();
const transfers = new Map();
const transferByRef = new Map();
/** reference -> scenario set before initiate (like the transaction scenario API) */
const transferScenarios = new Map();
let nextRecipientId = 1;
let nextTransferId = 1;

const MOMO_BANKS = [
  { name: "MTN Mobile Money", code: "MTN" },
  { name: "Telecel Cash", code: "TELECEL" },
];
const NUBAN_BANKS = [
  { name: "GCB Bank", code: "GCB" },
  { name: "Ecobank Ghana", code: "ECO" },
];

function transferStatusFor(t) {
  const scenario = t.scenario ?? "pending";
  if (scenario === "success" || scenario === "success-wrong-amount" || scenario === "success-wrong-currency") {
    return "success";
  }
  if (scenario === "failed" || scenario === "reversed" || scenario === "pending") return scenario;
  return "pending";
}

function transferPayload(t, transferCode) {
  const out = {
    reference: t.reference,
    transfer_code: transferCode,
    status: transferStatusFor(t),
    amount: t.amount,
    currency: t.currency,
    recipient: { recipient_code: t.recipientCode },
  };
  if (t.scenario === "success-wrong-amount") out.amount = t.amount + 100;
  if (t.scenario === "success-wrong-currency") out.currency = "NGN";
  return out;
}

function log(...args) {
  // No request headers, no key material — method/path/status/refs only.
  console.log(`[paystack-stub]`, ...args);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({ __unparseable: true });
      }
    });
    req.on("error", reject);
  });
}

/** Shape check ONLY — never the value. */
function authLooksLikeTestKey(req) {
  const h = req.headers["authorization"] ?? "";
  return h.startsWith("Bearer sk_test_");
}

function recordAudit(req, url, status) {
  if (audit.length >= 500) audit.shift();
  audit.push({
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    status,
    authLooksLikeTestKey: authLooksLikeTestKey(req),
  });
}

/** Paystack-style verification payload for a stored ref + its scenario. */
function verifyPayload(ref) {
  const t = refs.get(ref);
  t.verifyCalls += 1;

  const base = {
    id: t.transactionId,
    reference: ref,
    amount: t.amount,
    currency: t.currency,
    email: t.email,
    channels: ["card"],
    metadata: { app: "flexidata" },
    access_code: t.accessCode,
    gateway_reference: `stub-${t.transactionId}`,
    date: new Date().toISOString(),
    paid_at: null,
    channel: "card",
    gateway_response: null,
    customer: {
      id: 1000 + (t.transactionId % 1000),
      email: t.email,
      first_name: "E2E",
      last_name: "Tester",
      phone_number: "0244000000",
    },
  };

  const scenario = t.scenario ?? "pending";
  let status;
  if (scenario === "flip-success") {
    status = t.verifyCalls <= (t.failBefore ?? 1) ? "failed" : "success";
  } else if (scenario === "pending" || scenario === "(unset)") {
    status = "ongoing";
  } else {
    status = scenario;
  }
  // Map the control-level scenario names to Paystack's raw status strings.
  const rawStatus =
    status === "ongoing" || status === "success" || status === "failed" || status === "abandoned"
      ? status
      : "failed";

  const out = { ...base, status: rawStatus };

  if (rawStatus === "success") {
    out.paid_at = new Date().toISOString();
    out.gateway_response = "approved";
  }
  if (rawStatus === "failed") {
    out.gateway_response = "Card declined (stub)";
  }
  if (rawStatus === "abandoned") {
    out.gateway_response = "Checkout abandoned (stub)";
  }

  if (scenario === "success-wrong-amount") {
    out.amount = t.amount + 500;
  }
  if (scenario === "success-wrong-currency") {
    out.currency = "NGN";
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    // ---- control API (E2E script only) -----------------------------------
    if (p === "/_stub/health") {
      return json(res, 200, { ok: true });
    }
    if (p === "/_stub/reset" && req.method === "POST") {
      refs.clear();
      audit.length = 0;
      recipients.clear();
      transfers.clear();
      transferByRef.clear();
      transferScenarios.clear();
      return json(res, 200, { ok: true });
    }
    if (p === "/_stub/scenario" && req.method === "POST") {
      const body = await readBody(req);
      const ref = typeof body.ref === "string" ? body.ref.trim() : "";
      const scenario = typeof body.scenario === "string" ? body.scenario.trim() : "";
      const allowed = [
        "pending",
        "success",
        "success-wrong-amount",
        "success-wrong-currency",
        "failed",
        "abandoned",
        "flip-success",
      ];
      if (!ref || !allowed.includes(scenario)) {
        return json(res, 400, { ok: false, error: "ref + one of the allowed scenarios required" });
      }
      let t = refs.get(ref);
      if (!t) {
        // Allow setting a scenario before initialize (verify will 404 anyway
        // until initialize happens, which matches "transaction not found").
        t = {
          amount: 0,
          currency: "GHS",
          email: "",
          accessCode: "",
          scenario: null,
          failBefore: 1,
          verifyCalls: 0,
          transactionId: nextTransactionId++,
        };
        refs.set(ref, t);
      }
      t.scenario = scenario;
      t.failBefore = Number.isInteger(body.failBefore) && body.failBefore >= 0 ? body.failBefore : 1;
      t.verifyCalls = 0;
      return json(res, 200, { ok: true, ref, scenario });
    }
    if (p === "/_stub/transfer-scenario" && req.method === "POST") {
      const body = await readBody(req);
      const reference = typeof body.reference === "string" ? body.reference.trim() : "";
      const scenario = typeof body.scenario === "string" ? body.scenario.trim() : "";
      const allowed = ["pending", "success", "success-wrong-amount", "success-wrong-currency", "failed", "reversed"];
      if (!reference || !allowed.includes(scenario)) {
        return json(res, 400, { ok: false, error: "reference + one of the allowed scenarios required" });
      }
      const code = transferByRef.get(reference);
      if (code) transfers.get(code).scenario = scenario;
      else transferScenarios.set(reference, scenario);
      return json(res, 200, { ok: true, reference, scenario });
    }
    if (p === "/_stub/audit" && req.method === "GET") {
      return json(res, 200, {
        ok: true,
        requests: audit,
        refs: Object.fromEntries(
          [...refs.entries()].map(([r, t]) => [
            r,
            {
              amount: t.amount,
              currency: t.currency,
              scenario: t.scenario,
              verifyCalls: t.verifyCalls,
              authLooksLikeTestKey: t.authLooksLikeTestKey,
              callbackUrl: t.callbackUrl ?? null,
              channels: t.channels ?? null,
              metadata: t.metadata ?? null,
            },
          ]),
        ),
        recipients: Object.fromEntries(
          [...recipients.entries()].map(([code, r]) => [
            code,
            { type: r.type, name: r.name, accountNumber: r.accountNumber, bankCode: r.bankCode, currency: r.currency },
          ]),
        ),
        transfers: Object.fromEntries(
          [...transfers.entries()].map(([code, t]) => [
            code,
            {
              reference: t.reference,
              amount: t.amount,
              currency: t.currency,
              recipientCode: t.recipientCode,
              scenario: t.scenario,
              authLooksLikeTestKey: t.authLooksLikeTestKey,
              initiateCalls: t.initiateCalls,
            },
          ]),
        ),
      });
    }

    // ---- Paystack API surface --------------------------------------------
    if (p === "/transaction/initialize" && req.method === "POST") {
      const body = await readBody(req);
      if (body.__unparseable) return json(res, 400, { status: false, message: "Invalid JSON body" });
      const reference = typeof body.reference === "string" ? body.reference.trim() : "";
      const amount = body.amount;
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!reference || !Number.isInteger(amount) || amount <= 0 || !email) {
        return json(res, 400, {
          status: false,
          message: "reference, a positive integer amount and email are required",
        });
      }
      const t = {
        amount,
        currency: typeof body.currency === "string" && body.currency ? body.currency : "GHS",
        email,
        accessCode: String(nextAccessCode++).padStart(8, "0"),
        scenario: null,
        failBefore: 1,
        verifyCalls: 0,
        transactionId: nextTransactionId++,
        authLooksLikeTestKey: authLooksLikeTestKey(req),
        // Recorded so the E2E can prove where Paystack would send the customer
        // after paying, and which channels the app offered. No key material.
        callbackUrl: typeof body.callback_url === "string" ? body.callback_url : null,
        channels: Array.isArray(body.channels) ? body.channels : null,
        metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : null,
      };
      refs.set(reference, t);
      return json(res, 200, {
        status: true,
        message: "Transaction initialized",
        data: {
          authorization_url: `http://${HOST}:${PORT}/checkout/${encodeURIComponent(reference)}?access_code=${t.accessCode}`,
          access_code: t.accessCode,
          reference,
          amount,
          currency: t.currency,
          email,
          channels: Array.isArray(body.channels) ? body.channels : ["card"],
          callback_url: typeof body.callback_url === "string" ? body.callback_url : null,
          metadata: body.metadata ?? {},
          date: new Date().toISOString(),
        },
      });
    }

    const verifyMatch = p.match(/^\/transaction\/verify\/([^/]+)$/);
    if (verifyMatch && req.method === "GET") {
      const ref = decodeURIComponent(verifyMatch[1]);
      const t = refs.get(ref);
      if (!t) {
        return json(res, 404, {
          status: false,
          message: `Transaction with reference ${ref} not found`,
          data: null,
        });
      }
      return json(res, 200, { status: true, message: "Verification successful", data: verifyPayload(ref) });
    }

    const checkoutMatch = p.match(/^\/checkout\/([^/]+)$/);
    if (checkoutMatch && req.method === "GET") {
      const ref = decodeURIComponent(checkoutMatch[1]);
      const t = refs.get(ref);
      const codeOk = t && url.searchParams.get("access_code") === t.accessCode;
      if (!t || !codeOk) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        return res.end("<!doctype html><title>Access denied</title><h1>Invalid or expired access code</h1>");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        `<!doctype html><html><head><title>Paystack Checkout (local stub)</title></head>` +
          `<body><h1>Paystack TEST checkout — local stub</h1>` +
          `<p>Reference: <code>${ref}</code></p>` +
          `<p>Amount: ${t.amount} ${t.currency}</p>` +
          `<p>Email: ${t.email}</p>` +
          `<p>This page exists so E2E can confirm the authorization URL the app` +
          ` received is a real, reachable checkout page. Payment outcomes are` +
          ` controlled by the E2E script via the stub's control API — no card` +
          ` is ever used.</p></body></html>`,
      );
    }

    // ---- Paystack Transfers surface (Phase B payouts) -----------------------
    if (p === "/bank" && req.method === "GET") {
      const type = url.searchParams.get("type") ?? "";
      const list = type === "nuban" ? NUBAN_BANKS : type === "mobile_money" ? MOMO_BANKS : [...MOMO_BANKS, ...NUBAN_BANKS];
      return json(res, 200, {
        status: true,
        message: "Banks retrieved",
        data: list.map((b, i) => ({ id: 100 + i, name: b.name, code: b.code, currency: "GHS", type })),
      });
    }

    if (p === "/transferrecipient" && req.method === "POST") {
      const body = await readBody(req);
      if (body.__unparseable) return json(res, 400, { status: false, message: "Invalid JSON body" });
      const type = body.type;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const accountNumber = typeof body.account_number === "string" ? body.account_number.trim() : "";
      const bankCode = typeof body.bank_code === "string" ? body.bank_code.trim() : "";
      if ((type !== "mobile_money" && type !== "nuban") || !name || !accountNumber || !bankCode) {
        return json(res, 400, { status: false, message: "type, name, account_number and bank_code are required" });
      }
      const known = [...MOMO_BANKS, ...NUBAN_BANKS].some((b) => b.code === bankCode);
      if (!known) {
        return json(res, 400, { status: false, message: `Unknown bank code ${bankCode}` });
      }
      const code = `RCP_stub${String(nextRecipientId++).padStart(4, "0")}`;
      recipients.set(code, {
        type,
        name,
        accountNumber,
        bankCode,
        currency: typeof body.currency === "string" ? body.currency : "GHS",
      });
      return json(res, 200, {
        status: true,
        message: "Recipient created",
        data: { recipient_code: code, type, name, account_number: accountNumber, bank_code: bankCode },
      });
    }

    if (p === "/transfer" && req.method === "POST") {
      const body = await readBody(req);
      if (body.__unparseable) return json(res, 400, { status: false, message: "Invalid JSON body" });
      const amount = body.amount;
      const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
      const reference = typeof body.reference === "string" ? body.reference.trim() : "";
      if (!Number.isInteger(amount) || amount <= 0) {
        return json(res, 400, { status: false, message: "amount must be a positive integer (minor units)" });
      }
      if (!recipient || !recipients.has(recipient)) {
        return json(res, 400, { status: false, message: "Unknown recipient" });
      }
      if (!reference) {
        return json(res, 400, { status: false, message: "reference is required" });
      }
      if (transferByRef.has(reference)) {
        // Mimic Paystack: stable references are unique — a double-submit with
        // the same reference is refused, never forked into a second transfer.
        return json(res, 400, { status: false, message: "Reference already exists" });
      }
      const code = `TRF_stub${String(nextTransferId++).padStart(4, "0")}`;
      const scenario = transferScenarios.get(reference) ?? "pending";
      transferScenarios.delete(reference);
      transfers.set(code, {
        reference,
        amount,
        currency: typeof body.currency === "string" && body.currency ? body.currency : "GHS",
        recipientCode: recipient,
        scenario,
        authLooksLikeTestKey: authLooksLikeTestKey(req),
        initiateCalls: 1,
      });
      transferByRef.set(reference, code);
      return json(res, 200, {
        status: true,
        message: "Transfer initiated",
        data: { reference, transfer_code: code, status: transferStatusFor(transfers.get(code)) },
      });
    }

    const fetchTransferMatch = p.match(/^\/transfer\/([^/]+)$/);
    if (fetchTransferMatch && req.method === "GET") {
      const code = decodeURIComponent(fetchTransferMatch[1]);
      const t = transfers.get(code);
      if (!t) {
        return json(res, 404, { status: false, message: `Transfer ${code} not found`, data: null });
      }
      return json(res, 200, { status: true, message: "Transfer retrieved", data: transferPayload(t, code) });
    }

    json(res, 404, { status: false, message: "Unknown endpoint", data: null });
  } catch (error) {
    log("error", req.method, p, error?.message ?? String(error));
    json(res, 500, { status: false, message: "Stub internal error", data: null });
  } finally {
    if (p.startsWith("/transaction/") || p.startsWith("/transfer") || p === "/bank") {
      recordAudit(req, url, res.statusCode ?? 0);
    }
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (test-mode stand-in only — never exposes anything externally)`);
});

process.on("SIGTERM", () => {
  log("SIGTERM — shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
process.on("SIGINT", () => process.exit(0));
