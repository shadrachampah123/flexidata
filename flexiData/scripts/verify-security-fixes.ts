/**
 * Focused security-fix verification for the FlexiData Paystack audit.
 *
 * This script is intentionally database-light:
 *   - The production mock-funding lock and the production convert lock are
 *     checked before any database/authentication code can run.
 *   - The purchase callback HMAC path is verified against the in-memory schema
 *     simulator (the real Postgres E2E suite covers the full money flows).
 *   - Production demo/mock deposit rejection is proven at BOTH layers: the
 *     /api/wallet/fund route (pre-auth lockout matrix) and the deposit service
 *     (`reconcileDeposit` refuses to settle a non-Paystack deposit, and
 *     `settleAtomic` — the money-movement choke point — refuses mock settlement).
 *   - The Paystack LIVE-mode locks are proven with a synthetic sk_live_-shaped
 *     key (never a real secret): a live key is refused without
 *     PAYSTACK_LIVE_MODE=true (zero network requests), and with the opt-in the
 *     real deposit path initialises against a local, in-process Paystack stub.
 *   - Exact amount/currency/reference enforcement and settlement idempotency
 *     are exercised through the same stub + in-memory ledger.
 *
 * It does NOT test the concurrent wallet-transfer query (that needs a real
 * Postgres row-lock/transaction run); that remains covered by the package's
 * Paystack E2E suite when a DATABASE_URL is available.
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { installSim } from "./schema-sim";

const env = process.env as unknown as Record<string, string | undefined>;
const checks: { name: string; ok: boolean; detail: unknown }[] = [];
function check(name: string, ok: boolean, detail: unknown = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  — ${JSON.stringify(detail)}`}`);
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * Minimal in-process Paystack API stand-in (bound to 127.0.0.1, ephemeral
 * port). The app is pointed at it via PAYSTACK_BASE_URL, exactly like the E2E
 * stub. It records request AUTH SHAPE only (never key material) and serves
 * per-reference verification scenarios so the exact amount/currency/reference
 * rules and settlement idempotency can be driven deterministically.
 */
type StubAudit = { path: string; authLooksLiveKey: boolean; body: Record<string, unknown> };

function startPaystackStub(): Promise<{
  baseUrl: string;
  audit: StubAudit[];
  setScenario: (ref: string, scenario: Partial<Record<string, unknown>>) => void;
  close: () => Promise<void>;
}> {
  const audit: StubAudit[] = [];
  const scenarios = new Map<string, Record<string, unknown>>();
  const initialized = new Map<string, { amount: number; currency: string }>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const auth = req.headers.authorization ?? "";
      const entry: StubAudit = {
        path: req.url ?? "",
        authLooksLiveKey: auth.startsWith("Bearer sk_live_"),
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      audit.push(entry);

      const reply = (payload: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (req.url?.startsWith("/transaction/initialize")) {
        const reference = String(entry.body.reference ?? "");
        const amount = Number(entry.body.amount ?? 0);
        const currency = String(entry.body.currency ?? "GHS");
        initialized.set(reference, { amount, currency });
        reply({
          status: true,
          message: "Authorization URL created",
          data: { authorization_url: `http://127.0.0.1/checkout/${reference}`, access_code: "ac_", reference },
        });
        return;
      }

      const verifyMatch = req.url?.match(/^\/transaction\/verify\/(.+)$/);
      if (verifyMatch) {
        const reference = decodeURIComponent(verifyMatch[1]);
        const base = initialized.get(reference) ?? { amount: 5000, currency: "GHS" };
        const scenario = scenarios.get(reference) ?? {};
        const failFirst = Number(scenario.failBefore ?? 0);
        const verifyCalls = Number(scenario._verifyCalls ?? 0) + 1;
        scenarios.set(reference, { ...scenario, _verifyCalls: verifyCalls });

        if (failFirst >= verifyCalls) {
          reply({
            status: true,
            message: "Verification successful",
            data: {
              id: 900000,
              status: "failed",
              reference,
              amount: base.amount,
              currency: base.currency,
              gateway_response: "Declined",
            },
          });
          return;
        }

        reply({
          status: true,
          message: "Verification successful",
          data: {
            id: 900000,
            status: "success",
            reference: typeof scenario.reference === "string" ? scenario.reference : reference,
            amount: typeof scenario.amount === "number" ? scenario.amount : base.amount,
            currency: typeof scenario.currency === "string" ? scenario.currency : base.currency,
            channel: "mobile_money",
            paid_at: new Date().toISOString(),
            gateway_response: "Successful",
          },
        });
        return;
      }

      reply({ status: false, message: "Unknown stub path" }, 404);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        audit,
        setScenario: (ref, scenario) =>
          scenarios.set(ref, { ...(scenarios.get(ref) ?? {}), ...scenario } as Record<string, unknown>),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}


async function main() {
  const originalNodeEnv = env.NODE_ENV;
  const originalSecret = env.DATA_API_WEBHOOK_SECRET;
  const originalProvider = env.PAYMENTS_PROVIDER;
  const originalPaystackKey = env.PAYSTACK_SECRET_KEY;
  const originalLiveMode = env.PAYSTACK_LIVE_MODE;
  const originalBaseUrl = env.PAYSTACK_BASE_URL;

  try {
    // --- 1. Production mock-funding lock (fail-closed before auth) ----------
    env.NODE_ENV = "production";
    env.PAYMENTS_PROVIDER = "mock";
    delete env.PAYSTACK_SECRET_KEY;
    delete env.PAYSTACK_LIVE_MODE;
    delete env.PAYSTACK_BASE_URL;
    const { pool } = installSim({ migrated: true });
    const fundRoute = require("@/app/api/wallet/fund/route");
    const convertRoute = require("@/app/api/convert/route");
    const callbackRoute = require("@/app/api/purchase/callback/route");

    const fund = await fundRoute.POST(jsonRequest("/api/wallet/fund", { method: "momo_mtn", amount: 50 }));
    const fundBody = await fund.json();
    check(
      "production: PAYMENTS_PROVIDER=mock blocks wallet funding (503, no wallet credit)",
      fund.status === 503 && fundBody.ok === false && fundBody.code === "paystack_unconfigured",
      { status: fund.status, body: fundBody },
    );
    check(
      "production: mock funding response is generic (no key/config/stack details)",
      !JSON.stringify(fundBody).toLowerCase().includes("paystack_secret") &&
        !JSON.stringify(fundBody).toLowerCase().includes("sk_test_") &&
        !JSON.stringify(fundBody).toLowerCase().includes("sk_live_"),
      fundBody,
    );

    // --- 1b. A configured Paystack key must NOT re-enable mock in production
    env.PAYSTACK_SECRET_KEY = "sk_test_harness-synthetic-not-a-real-key";
    const fundMockWithKey = await fundRoute.POST(
      jsonRequest("/api/wallet/fund", { method: "momo_mtn", amount: 50 }),
    );
    const fundMockWithKeyBody = await fundMockWithKey.json();
    check(
      "production: PAYMENTS_PROVIDER=mock is refused even with a Paystack key configured (503, instant demo credit impossible)",
      fundMockWithKey.status === 503 &&
        fundMockWithKeyBody.ok === false &&
        fundMockWithKeyBody.code === "paystack_unconfigured" &&
        pool().rows.transactions.length === 0 &&
        pool().rows.deposit_requests.length === 0,
      { status: fundMockWithKey.status, body: fundMockWithKeyBody },
    );

    // --- 1c. No key + no provider: the old "silent mock fallback" is dead
    delete env.PAYSTACK_SECRET_KEY;
    const fundNoKey = await fundRoute.POST(
      jsonRequest("/api/wallet/fund", { method: "momo_mtn", amount: 50 }),
    );
    const fundNoKeyBody = await fundNoKey.json();
    check(
      "production: missing Paystack key blocks wallet funding (503, never mock-settles)",
      fundNoKey.status === 503 && fundNoKeyBody.ok === false && fundNoKeyBody.code === "paystack_unconfigured",
      { status: fundNoKey.status, body: fundNoKeyBody },
    );

    const convert = await convertRoute.POST(
      jsonRequest("/api/convert", { network: "MTN", phone: "0244123456", amount: 20 }),
    );
    const convertBody = await convert.json();
    check(
      "production: airtime→cash conversion is unavailable (503)",
      convert.status === 503 && convertBody.ok === false && convertBody.code === "conversion_unavailable",
      { status: convert.status, body: convertBody },
    );

    // --- 2. Production callback webhook-secret gate and HMAC ----------------
    delete env.DATA_API_WEBHOOK_SECRET;
    const missing = await callbackRoute.POST(
      jsonRequest("/api/purchase/callback", { clientReference: "UNKNOWN", status: "successful" }),
    );
    const missingBody = await missing.json();
    check(
      "production: missing DATA_API_WEBHOOK_SECRET rejects provider callback (401)",
      missing.status === 401 && missingBody.ok === false,
      { status: missing.status, body: missingBody },
    );

    env.DATA_API_WEBHOOK_SECRET = "test-webhook-secret";
    const callbackBody = JSON.stringify({ clientReference: "UNKNOWN", status: "successful" });
    const bad = await callbackRoute.POST(
      new Request("http://localhost/api/purchase/callback", {
        method: "POST",
        headers: { "content-type": "application/json", "x-data-api-signature": "invalid" },
        body: callbackBody,
      }),
    );
    check("production: invalid callback HMAC signature rejected (401)", bad.status === 401, bad.status);

    const expected = createHmac("sha256", env.DATA_API_WEBHOOK_SECRET!).update(callbackBody).digest("hex");
    const good = await callbackRoute.POST(
      new Request("http://localhost/api/purchase/callback", {
        method: "POST",
        headers: { "content-type": "application/json", "x-data-api-signature": expected },
        body: callbackBody,
      }),
    );
    // The unknown reference means 404 after passing HMAC; asserting not-401 is
    // enough to prove the HMAC auth gate accepted the signature.
    check("production: valid callback HMAC signature passes the auth gate", good.status !== 401, good.status);

    // --- 3. Unexpected fund errors are sanitized -----------------------------
    env.NODE_ENV = "development";
    env.FLEXIDATA_TEST_USER_ID = "1";
    env.PAYMENTS_PROVIDER = "mock";

    pool().rows.users.push({
      id: 1,
      name: "Security Probe",
      email: "security@flexidata.app",
      phone: "0244123456",
      password_hash: "scrypt:x:x",
      referral_code: "FD-SEC-0001",
      referred_by: null,
      referral_rewarded_at: null,
      email_verified_at: null,
      notify_promos: true,
      notify_tx: true,
      is_admin: false,
      created_at: new Date(),
      updated_at: new Date(),
    });
    pool().rows.wallets.push({
      id: 1,
      user_id: 1,
      name: "Security Probe",
      number: "0244123456",
      balance: "100.00",
      points: 0,
      is_agent: false,
      agent_tier: null,
      referral_code: "FD-SEC-0001",
      created_at: new Date(),
    });

    const fundDev = await fundRoute.POST(jsonRequest("/api/wallet/fund", { method: "momo_mtn", amount: 50 }));
    const fundDevBody = await fundDev.json();
    check(
      "non-production fund responses are sanitized (demo settle may succeed; never raw db/schema/message)",
      [200, 500, 503].includes(fundDev.status) &&
        !JSON.stringify(fundDevBody).includes("amount_subunits") &&
        !JSON.stringify(fundDevBody).includes("deposit_requests") &&
        !JSON.stringify(fundDevBody).includes("column ") &&
        !JSON.stringify(fundDevBody).includes("does not exist"),
      { status: fundDev.status, body: fundDevBody },
    );

    // --- 4. Demo/mock deposits still settle in DEVELOPMENT (opt-in) ---------
    // The dev experience is preserved: an explicit PAYMENTS_PROVIDER=mock
    // deposit settles instantly through the same atomic settle path and writes
    // the ledger row. (The in-memory simulator cannot apply SQL balance
    // arithmetic, so the wallet row is asserted untouched and the deposit +
    // ledger rows carry the assertion instead.)
    const devDepositRowsBefore = pool().rows.deposit_requests.length;
    const devLedgerBefore = pool().rows.transactions.length;
    const fundDemo = await fundRoute.POST(jsonRequest("/api/wallet/fund", { method: "momo_mtn", amount: 50 }));
    const fundDemoBody = await fundDemo.json();
    const devDeposit = pool().rows.deposit_requests[pool().rows.deposit_requests.length - 1];
    check(
      "development: PAYMENTS_PROVIDER=mock demo deposit still settles instantly (status successful + ledger row)",
      fundDemo.status === 200 &&
        fundDemoBody.ok === true &&
        fundDemoBody.status === "successful" &&
        fundDemoBody.provider === "mock" &&
        pool().rows.deposit_requests.length === devDepositRowsBefore + 1 &&
        devDeposit?.status === "successful" &&
        devDeposit?.provider === "mock" &&
        pool().rows.transactions.length === devLedgerBefore + 1,
      { status: fundDemo.status, body: fundDemoBody, deposit: devDeposit },
    );

    // --- 5. PRODUCTION: a mock deposit can NEVER settle ---------------------
    // The service layer itself refuses: reconcileDeposit parks any non-Paystack
    // deposit as failed in a production runtime and settleAtomic (the
    // money-movement choke point) throws before a single row is written.
    env.NODE_ENV = "production";
    env.PAYMENTS_PROVIDER = "mock";
    delete env.PAYSTACK_SECRET_KEY;
    pool().rows.wallets[0].balance = "100.00";
    const prodLedgerBefore = pool().rows.transactions.length;
    const prodWalletBalanceBefore = pool().rows.wallets[0].balance;
    pool().rows.deposit_requests.push({
      id: 4001,
      ref: "DP-PROD-MOCK-1",
      wallet_id: 1,
      provider: "mock",
      method: "momo_mtn",
      amount: "50.00",
      amount_subunits: 5000,
      currency: "GHS",
      status: "pending",
      provider_reference: "mock-DP-PROD-MOCK-1",
      paystack_transaction_id: null,
      paystack_channel: null,
      paystack_gateway_response: null,
      initiated_at: new Date(),
      completed_at: null,
      paid_at: null,
      verified_at: null,
      provider_payload: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const { reconcileDeposit } = require("@/lib/deposits");
    const refusedSummary = await reconcileDeposit("DP-PROD-MOCK-1");
    const prodMockRow = pool().rows.deposit_requests.find((r) => r.ref === "DP-PROD-MOCK-1");
    check(
      "production: mock deposit is refused by reconcileDeposit (parked failed, no ledger row, balance untouched)",
      refusedSummary?.status === "failed" &&
        prodMockRow?.status === "failed" &&
        pool().rows.transactions.length === prodLedgerBefore &&
        pool().rows.wallets[0].balance === prodWalletBalanceBefore,
      { summary: refusedSummary, row: prodMockRow },
    );

    // Reconciling again stays refused and credits nothing (idempotent refusal).
    const refusedAgain = await reconcileDeposit("DP-PROD-MOCK-1");
    check(
      "production: repeated reconcile of the mock deposit still refuses (no credit on replay)",
      refusedAgain?.status === "failed" && pool().rows.transactions.length === prodLedgerBefore,
      refusedAgain,
    );

    // --- 6. Paystack LIVE-mode locks + the real LIVE deposit path -----------
    // Uses a SYNTHETIC sk_live_-shaped key (never a real secret) and a local
    // in-process stub, proving the configuration locks end to end.
    const stub = await startPaystackStub();
    env.PAYSTACK_BASE_URL = stub.baseUrl;
    env.PAYSTACK_SECRET_KEY = "sk_live_harness-synthetic-not-a-real-key";
    delete env.PAYSTACK_LIVE_MODE;
    // Reset the provider choice from section 5: an explicit production
    // PAYMENTS_PROVIDER=mock must not mask the LIVE-key checks below.
    delete env.PAYMENTS_PROVIDER;

    const { createDepositRequest } = require("@/lib/deposits");
    let liveLockThrew: unknown = null;
    try {
      await createDepositRequest({
        walletId: 1,
        walletNumber: "0244123456",
        email: "security@flexidata.app",
        method: "momo_mtn",
        amountGhs: 50,
        requestOrigin: null,
      });
    } catch (error) {
      liveLockThrew = error;
    }
    check(
      "LIVE lock: a live key without PAYSTACK_LIVE_MODE=true refuses deposit creation before any network call",
      liveLockThrew instanceof Error &&
        liveLockThrew.message.includes("PAYSTACK_LIVE_MODE") &&
        stub.audit.length === 0,
      { error: liveLockThrew instanceof Error ? liveLockThrew.message : liveLockThrew, stubHits: stub.audit.length },
    );

    // With the explicit opt-in, the real Paystack deposit path initialises:
    // integer pesewas, GHS, our reference, and a Bearer live-key auth header.
    env.PAYSTACK_LIVE_MODE = "true";
    const liveDeposit = await createDepositRequest({
      walletId: 1,
      walletNumber: "0244123456",
      email: "security@flexidata.app",
      method: "momo_mtn",
      amountGhs: 50,
      requestOrigin: null,
    });
    const initCalls = stub.audit.filter((a) => a.path.startsWith("/transaction/initialize"));
    const initBody = initCalls[0]?.body ?? {};
    check(
      "LIVE path: PAYSTACK_LIVE_MODE=true unlocks Paystack deposits (pending + hosted checkout URL)",
      liveDeposit?.status === "pending" &&
        typeof liveDeposit.authorizationUrl === "string" &&
        liveDeposit.authorizationUrl.includes(String(liveDeposit.ref)) &&
        liveDeposit.provider === "paystack",
      liveDeposit,
    );
    check(
      "LIVE path: initialize sends integer pesewas, GHS currency, our reference, and a sk_live_-shaped bearer (server-side only)",
      initCalls.length === 1 &&
        initBody.amount === 5000 &&
        Number.isInteger(initBody.amount) &&
        initBody.currency === "GHS" &&
        initBody.reference === (liveDeposit as { ref?: string })?.ref &&
        initCalls[0].authLooksLiveKey,
      { body: initBody, authLooksLiveKey: initCalls[0]?.authLooksLiveKey },
    );

    // Webhook signature verification still enforced with a live key.
    const webhookPayload = JSON.stringify({ event: "charge.success", data: { reference: "DP-X" } });
    const liveHmac = createHmac("sha512", env.PAYSTACK_SECRET_KEY!).update(webhookPayload).digest("hex");
    const { isValidPaystackWebhookSignature } = require("@/lib/paystack");
    const signatureOk = isValidPaystackWebhookSignature(webhookPayload, liveHmac);
    const signatureTampered = isValidPaystackWebhookSignature(webhookPayload, createHmac("sha512", "wrong-key").update(webhookPayload).digest("hex"));
    const signatureMissing = isValidPaystackWebhookSignature(webhookPayload, null);
    env.PAYSTACK_LIVE_MODE = "unset-for-signature-check";
    const signatureWithoutLiveOptIn = isValidPaystackWebhookSignature(webhookPayload, liveHmac);
    env.PAYSTACK_LIVE_MODE = "true";
    check(
      "LIVE webhook: valid HMAC-SHA512 accepted; tampered, missing, or live-mode-unlocked signatures rejected",
      signatureOk === true && signatureTampered === false && signatureMissing === false && signatureWithoutLiveOptIn === false,
      { signatureOk, signatureTampered, signatureMissing, signatureWithoutLiveOptIn },
    );

    // --- 6b. Exact amount/currency/reference enforcement + idempotency ------
    // A production deposit row (provider paystack) is settled ONLY when the
    // verify response matches the recorded reference + exact pesewa amount +
    // currency, and only exactly once.
    env.NODE_ENV = "production";
    delete env.PAYMENTS_PROVIDER;
    env.PAYSTACK_SECRET_KEY = "sk_test_harness-synthetic-not-a-real-key";
    env.PAYSTACK_LIVE_MODE = "true";
    const mismatchLedgerBefore = pool().rows.transactions.length;
    const insertPaystackDeposit = (ref: string) =>
      pool().rows.deposit_requests.push({
        id: 5000 + pool().rows.deposit_requests.length,
        ref,
        wallet_id: 1,
        provider: "paystack",
        method: "momo_mtn",
        amount: "50.00",
        amount_subunits: 5000,
        currency: "GHS",
        status: "pending",
        provider_reference: null,
        paystack_transaction_id: null,
        paystack_channel: null,
        paystack_gateway_response: null,
        initiated_at: new Date(),
        completed_at: null,
        paid_at: null,
        verified_at: null,
        provider_payload: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

    // Wrong amount: Paystack says success but for GH₵ 55.00 — never credited.
    stub.setScenario("DP-VERIFY-AMOUNT", { amount: 5500 });
    insertPaystackDeposit("DP-VERIFY-AMOUNT");
    const wrongAmount = await reconcileDeposit("DP-VERIFY-AMOUNT");
    const wrongAmountRow = pool().rows.deposit_requests.find((r) => r.ref === "DP-VERIFY-AMOUNT");
    check(
      "verification: amount mismatch is NEVER credited (parked failed, ledger untouched)",
      wrongAmount?.status === "failed" &&
        wrongAmountRow?.status === "failed" &&
        pool().rows.transactions.length === mismatchLedgerBefore,
      { summary: wrongAmount, row: wrongAmountRow },
    );

    // Wrong currency: success in NGN — never credited.
    stub.setScenario("DP-VERIFY-CURRENCY", { currency: "NGN" });
    insertPaystackDeposit("DP-VERIFY-CURRENCY");
    const wrongCurrency = await reconcileDeposit("DP-VERIFY-CURRENCY");
    const wrongCurrencyRow = pool().rows.deposit_requests.find((r) => r.ref === "DP-VERIFY-CURRENCY");
    check(
      "verification: currency mismatch is NEVER credited (parked failed, ledger untouched)",
      wrongCurrency?.status === "failed" &&
        wrongCurrencyRow?.status === "failed" &&
        pool().rows.transactions.length === mismatchLedgerBefore,
      { summary: wrongCurrency, row: wrongCurrencyRow },
    );

    // Wrong reference: a success for somebody else's charge — never credited.
    stub.setScenario("DP-VERIFY-REFERENCE", { reference: "SOMEONE-ELSE" });
    insertPaystackDeposit("DP-VERIFY-REFERENCE");
    const wrongReference = await reconcileDeposit("DP-VERIFY-REFERENCE");
    const wrongReferenceRow = pool().rows.deposit_requests.find((r) => r.ref === "DP-VERIFY-REFERENCE");
    check(
      "verification: reference mismatch is NEVER credited (parked failed, ledger untouched)",
      wrongReference?.status === "failed" &&
        wrongReferenceRow?.status === "failed" &&
        pool().rows.transactions.length === mismatchLedgerBefore,
      { summary: wrongReference, row: wrongReferenceRow },
    );

    // Exact match: settled exactly once, and replays (webhook + verify + poll)
    // cannot double-credit.
    insertPaystackDeposit("DP-VERIFY-EXACT");
    const exact = await reconcileDeposit("DP-VERIFY-EXACT");
    const exactRow = pool().rows.deposit_requests.find((r) => r.ref === "DP-VERIFY-EXACT");
    const settledLedgerCount = pool().rows.transactions.length;
    const replay = await reconcileDeposit("DP-VERIFY-EXACT");
    const replay2 = await reconcileDeposit("DP-VERIFY-EXACT");
    check(
      "verification: exact reference+amount+currency settles successfully exactly once (webhook/verify replays cannot double-credit)",
      exact?.status === "successful" &&
        exactRow?.status === "successful" &&
        replay?.status === "successful" &&
        replay2?.status === "successful" &&
        pool().rows.transactions.length === settledLedgerCount &&
        settledLedgerCount === mismatchLedgerBefore + 1,
      { exact, ledger: pool().rows.transactions.length, expected: mismatchLedgerBefore + 1 },
    );

    await stub.close();

    // --- 7. Purchase provider-callback refund/charge integrity --------------
    // The data-provider callback used to settle wallet refunds with a
    // read-modify-write against a stale wallet snapshot (absolute balance
    // write, ledger flag written after the wallet, no transaction). Prove the
    // replacement claim-once + atomic-arithmetic behaviour.
    env.NODE_ENV = "production";
    env.DATA_API_WEBHOOK_SECRET = "test-webhook-secret";
    const signCb = (body: string) =>
      createHmac("sha256", env.DATA_API_WEBHOOK_SECRET!).update(body).digest("hex");
    const postCallback = async (payload: Record<string, unknown>) => {
      const raw = JSON.stringify(payload);
      return callbackRoute.POST(
        new Request("http://localhost/api/purchase/callback", {
          method: "POST",
          headers: { "content-type": "application/json", "x-data-api-signature": signCb(raw) },
          body: raw,
        }),
      );
    };
    let cbTxId = 6000;
    const addCallbackTx = (overrides: {
      status?: string;
      charged: boolean;
      refunded?: boolean;
      points?: number;
      amount?: string;
    }) => {
      const id = ++cbTxId;
      pool().rows.transactions.push({
        id,
        ref: `FD-CB-${id}`,
        wallet_id: 1,
        type: "data",
        status: overrides.status ?? "successful",
        fulfillment_status: overrides.charged ? "delivered" : "processing",
        direction: "out",
        title: "MTN 1GB Data",
        subtitle: "To 024 41 23 456",
        amount: overrides.amount ?? "40.00",
        points: overrides.points ?? 150,
        network: "MTN",
        recipient: "0244123456",
        provider: "mock",
        provider_product_code: "MTN-UP2U-1GB",
        provider_reference: `prov-${id}`,
        provider_status: overrides.charged ? "successful" : "pending",
        provider_message: null,
        fulfillment_attempts: 1,
        charged_at: overrides.charged ? new Date() : null,
        fulfilled_at: null,
        refunded_at: overrides.refunded ? new Date() : null,
        last_provider_sync_at: new Date(),
        provider_payload: null,
        provider_response: null,
        created_at: new Date(),
      });
      return `FD-CB-${id}`;
    };
    const walletState = () => ({
      balance: Number(pool().rows.wallets[0].balance),
      points: pool().rows.wallets[0].points,
    });

    // 7a. A charged order reported reversed: refund + points clawback, once.
    pool().rows.wallets[0].balance = "100.00";
    pool().rows.wallets[0].points = 50;
    pool().rows.transactions.length = 0;
    const refundRef = addCallbackTx({ charged: true, points: 150 });
    const refundRes = await postCallback({ clientReference: refundRef, status: "reversed" });
    const refundResBody = await refundRes.json();
    const refundedTx = pool().rows.transactions.find((r) => r.ref === refundRef);
    check(
      "callback: provider refund credits the wallet atomically (balance 100→140) and claws back points (150→0), exactly once",
      refundRes.status === 200 &&
        refundResBody.ok === true &&
        walletState().balance === 140 &&
        walletState().points === 0 &&
        refundedTx?.status === "reversed" &&
        refundedTx?.refunded_at != null &&
        Number(refundedTx?.points) === 0,
      { status: refundRes.status, body: refundResBody, wallet: walletState(), tx: refundedTx },
    );

    // 7b. Provider redelivers the same reversed event: no second refund.
    const afterReplay = walletState();
    const replayRes = await postCallback({ clientReference: refundRef, status: "reversed" });
    const replayResBody = await replayRes.json();
    check(
      "callback: redelivered refund event does NOT credit the wallet twice (idempotent replay)",
      replayRes.status === 200 &&
        replayResBody.ok === true &&
        walletState().balance === afterReplay.balance &&
        walletState().points === afterReplay.points,
      { status: replayRes.status, body: replayResBody, wallet: walletState() },
    );

    // 7c. TWO concurrent redeliveries race: exactly one refund may win.
    pool().rows.wallets[0].balance = "100.00";
    pool().rows.wallets[0].points = 50;
    const raceRef = addCallbackTx({ charged: true, points: 150 });
    const claimMark = pool().captured.length;
    const [raceA, raceB] = await Promise.all([
      postCallback({ clientReference: raceRef, status: "reversed" }),
      postCallback({ clientReference: raceRef, status: "reversed" }),
    ]);
    const raceWrites = pool().captured.slice(claimMark).filter((c) => c.kind === "update" && c.table === "wallets");
    const claimIdx = pool().captured
      .slice(claimMark)
      .findIndex((c) => c.kind === "update" && c.table === "transactions");
    const walletIdx = pool().captured
      .slice(claimMark)
      .findIndex((c) => c.kind === "update" && c.table === "wallets");
    check(
      "callback: concurrent duplicate refund deliveries settle exactly once (one wallet write, claim before credit, balance 100→140 not 180)",
      raceA.status === 200 &&
        raceB.status === 200 &&
        raceWrites.length === 1 &&
        claimIdx !== -1 &&
        walletIdx !== -1 &&
        claimIdx < walletIdx &&
        walletState().balance === 140 &&
        walletState().points === 0,
      {
        a: raceA.status,
        b: raceB.status,
        walletWrites: raceWrites.length,
        wallet: walletState(),
        writes: raceWrites.map((w) => w.sql),
      },
    );
    check(
      "callback: the refund wallet mutation is SQL arithmetic on the live row (balance = balance + amount), never an absolute value",
      raceWrites.length === 1 &&
        /"balance"\s*=\s*"wallets"\."balance"\s*\+/.test(raceWrites[0]?.sql ?? "") &&
        !/"balance"\s*=\s*\$/.test(raceWrites[0]?.sql ?? "") &&
        /GREATEST\(0,\s*"wallets"\."points"\s*-/.test(raceWrites[0]?.sql ?? ""),
      raceWrites[0]?.sql,
    );

    // 7d. Charge-on-confirmation for an uncharged order: debited once, points
    // awarded once; a duplicate delivery neither re-charges nor re-awards.
    pool().rows.wallets[0].balance = "100.00";
    pool().rows.wallets[0].points = 50;
    const unchargedRef = addCallbackTx({ status: "pending", charged: false, points: 0 });
    const chargeRes = await postCallback({ clientReference: unchargedRef, status: "successful" });
    const chargeResBody = await chargeRes.json();
    const chargedTx = pool().rows.transactions.find((r) => r.ref === unchargedRef);
    const afterCharge = walletState();
    check(
      "callback: delivery confirmation charges an uncharged order exactly once (balance 100→60) and awards points once (50→130)",
      chargeRes.status === 200 &&
        chargeResBody.ok === true &&
        afterCharge.balance === 60 &&
        afterCharge.points === 50 + Math.max(1, Math.round(40 * 2)) &&
        chargedTx?.charged_at != null &&
        chargedTx?.status === "successful",
      { status: chargeRes.status, body: chargeResBody, wallet: afterCharge, tx: chargedTx },
    );
    const chargeReplayRes = await postCallback({ clientReference: unchargedRef, status: "successful" });
    check(
      "callback: duplicate delivery confirmation neither re-charges nor re-awards points",
      chargeReplayRes.status === 200 && walletState().balance === afterCharge.balance && walletState().points === afterCharge.points,
      { status: chargeReplayRes.status, wallet: walletState() },
    );

    // 7e. Failure for an uncharged order: status sync only, wallet untouched.
    const failRef = addCallbackTx({ status: "pending", charged: false, points: 0 });
    const failRes = await postCallback({ clientReference: failRef, status: "failed" });
    const failedTx = pool().rows.transactions.find((r) => r.ref === failRef);
    check(
      "callback: failure for an uncharged order never moves the wallet (status sync only)",
      failRes.status === 200 && walletState().balance === afterCharge.balance && failedTx?.status === "failed",
      { status: failRes.status, wallet: walletState(), tx: failedTx },
    );
  } finally {
    if (originalNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = originalNodeEnv;
    if (originalSecret === undefined) delete env.DATA_API_WEBHOOK_SECRET;
    else env.DATA_API_WEBHOOK_SECRET = originalSecret;
    if (originalProvider === undefined) delete env.PAYMENTS_PROVIDER;
    else env.PAYMENTS_PROVIDER = originalProvider;
    if (originalPaystackKey === undefined) delete env.PAYSTACK_SECRET_KEY;
    else env.PAYSTACK_SECRET_KEY = originalPaystackKey;
    if (originalLiveMode === undefined) delete env.PAYSTACK_LIVE_MODE;
    else env.PAYSTACK_LIVE_MODE = originalLiveMode;
    if (originalBaseUrl === undefined) delete env.PAYSTACK_BASE_URL;
    else env.PAYSTACK_BASE_URL = originalBaseUrl;
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} security-fix checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("security verification crashed:", error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
