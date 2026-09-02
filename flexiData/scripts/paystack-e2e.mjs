/**
 * FlexiData ⇄ Paystack E2E — fully automated, no human steps, no browser
 * required in CI.
 *
 * WHY THIS DESIGN
 * ---------------
 * Paystack's hosted checkout page (checkout.paystack.com) sits behind a WAF
 * that blocks datacenter / CI networks: GitHub Actions runners receive HTTP
 * 403, so browser automation cannot complete a test-card payment there.
 * That is an environment restriction, NOT an application failure — the REAL
 * Paystack TEST API (api.paystack.co) works fine from CI. So this suite:
 *
 *   PHASE A — real Paystack TEST API (api.paystack.co), no browser:
 *     account registration, order creation, REAL transaction initialization,
 *     REAL verification of an unpaid charge (must stay unsettled), and the
 *     full webhook security matrix (bad / missing / tampered / valid /
 *     unknown-ref signatures) signed with the real sk_test_ key.
 *     The hosted checkout page is PROBED but never asserted on: if the
 *     network (e.g. GitHub Actions) gets 403, we log an environment notice
 *     and move on — the payment flow itself is covered by Phase B.
 *
 *   PHASE B — the complete money flow against a LOCAL Paystack stub
 *     (scripts/paystack-stub.mjs, bound to 127.0.0.1 only). The app runs
 *     with PAYSTACK_BASE_URL pointed at the stub and exercises every
 *     outcome deterministically: success, webhook-first settlement,
 *     replay idempotency, amount mismatch, currency mismatch, declined
 *     card, abandoned checkout, pending charge, and — in Phase C — the
 *     fulfillment-failure parking rule (paid but provider failed: never
 *     auto-retried, never double-sent).
 *
 * SAFETY
 * ------
 *   - Refuses to run with a live (sk_live_…) key.
 *   - The secret key is read from env and never printed.
 *   - The stub never logs the key; Phase B additionally asserts that no
 *     response or log contains key material (enforced by the CI step).
 *   - No real customer money: TEST-mode keys only, and in the stub phase
 *     no card is ever used at all.
 *
 * Requirements: a production build of the app (next build) in this
 * directory, DATABASE_URL for direct DB assertions, and
 * PAYSTACK_SECRET_KEY (sk_test_…) unless E2E_STUB_ONLY=1.
 *
 * Environment knobs:
 *   E2E_STUB_ONLY=1             skip Phase A (offline dev runs); the stub
 *                               phase runs with a synthetic sk_test_ key
 *   E2E_CHECKOUT_HOST           expected hosted checkout host
 *                               (default checkout.paystack.com)
 *   E2E_TRY_HOSTED_CHECKOUT=1   best-effort real test-card payment on the
 *                               HOSTED page — for local machines where the
 *                               page is reachable (install puppeteer with
 *                               `npm i --no-save puppeteer`). Never used
 *                               in CI; any failure there is reported, not
 *                               fatal to the suite.
 *   E2E_REAL_POLL_MS            how long Phase A polls an unpaid real
 *                               charge (default 15000)
 *
 * Run: node scripts/paystack-e2e.mjs
 */
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT_A = Number(process.env.APP_PORT_A ?? 3000);
const PORT_B = Number(process.env.APP_PORT_B ?? 3100);
const PORT_C = Number(process.env.APP_PORT_C ?? 3200);
const APP_URL_A = `http://127.0.0.1:${PORT_A}`;
const APP_URL_B = `http://127.0.0.1:${PORT_B}`;
const APP_URL_C = `http://127.0.0.1:${PORT_C}`;
const STUB_PORT = Number(process.env.PAYSTACK_STUB_PORT ?? 4599);
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;
const STUB_SCRIPT = path.join(APP_ROOT, "scripts", "paystack-stub.mjs");

const REAL = process.env.E2E_STUB_ONLY !== "1";
const SECRET = process.env.PAYSTACK_SECRET_KEY?.trim() ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const EXPECT_CHECKOUT_HOST = process.env.E2E_CHECKOUT_HOST ?? "checkout.paystack.com";
const REAL_POLL_MS = Number(process.env.E2E_REAL_POLL_MS ?? 15_000);

// Synthetic TEST-mode key for offline stub-only runs. It is clearly not a
// real Paystack key and is used only so both sides of the webhook signature
// check (app + this script) share a key.
const ACTIVE_SECRET = REAL ? SECRET : `sk_test_stub-e2e-${Date.now().toString(36)}`;

if (REAL && !SECRET) {
  console.error("FATAL: PAYSTACK_SECRET_KEY is not set. Set your sk_test_… key, or use E2E_STUB_ONLY=1 for an offline run.");
  process.exit(2);
}
if (ACTIVE_SECRET.startsWith("sk_live_")) {
  console.error("FATAL: refusing to run — the configured Paystack key is a LIVE key (sk_live_…). Use a TEST key.");
  process.exit(2);
}
if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set (needed for direct DB assertions).");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Tiny result recorder
// ---------------------------------------------------------------------------
const results = [];
function record(name, ok, detail = "", kind = "test") {
  results.push({ name, ok, detail, kind });
  const tag = kind === "info" ? "INFO" : ok ? "PASS" : "FAIL";
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function assert(name, cond, detail = "") {
  record(name, Boolean(cond), detail, "test");
  return Boolean(cond);
}
function info(name, detail) {
  record(name, true, detail, "info");
}

// ---------------------------------------------------------------------------
// Process management: app instances + stub
// ---------------------------------------------------------------------------
const children = []; // { child, label, logPath }
function cleanup() {
  for (const { child, label } of children) {
    try {
      if (child.exitCode == null) {
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 5000);
        killTimer.unref();
        console.log(`[e2e] stopped ${label}`);
      }
    } catch {}
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

function logFile(label) {
  return `/tmp/flexidata-e2e-${label}-${process.pid}.log`;
}

function spawnApp(label, port, extraEnv = {}) {
  const logPath = logFile(`app-${port}`);
  const out = fs.openSync(logPath, "w");
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd: APP_ROOT,
      // The app always runs with exactly the key this script signs webhooks
      // with (the real sk_test_ key in CI; the synthetic one in stub-only runs).
      env: { ...process.env, PORT: String(port), PAYSTACK_SECRET_KEY: ACTIVE_SECRET, ...extraEnv },
      stdio: ["ignore", out, out],
    },
  );
  child.on("error", (e) => console.error(`[e2e] ${label} spawn error:`, e.message));
  children.push({ child, label, logPath });
  return { child, logPath };
}

async function waitFor(url, what, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`[e2e] FATAL: ${what} did not become healthy at ${url} within ${timeoutMs}ms`);
  console.error(`[e2e] last log lines:`);
  for (const { label, logPath } of children) {
    try {
      const tail = fs.readFileSync(logPath, "utf8").split("\n").slice(-15).join("\n");
      console.error(`--- ${label} (${logPath}) ---\n${tail}`);
    } catch {}
  }
  process.exit(1);
}

function spawnStub() {
  const logPath = logFile("stub");
  const out = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, [STUB_SCRIPT], {
    cwd: APP_ROOT,
    env: { ...process.env, PAYSTACK_STUB_PORT: String(STUB_PORT) },
    stdio: ["ignore", out, out],
  });
  children.push({ child, label: "paystack-stub", logPath });
  return { child, logPath };
}

// ---------------------------------------------------------------------------
// App HTTP client (cookie jar) — each instance gets its own
// ---------------------------------------------------------------------------
function makeClient(baseUrl) {
  const cookies = {};
  async function api(reqPath, body, method = body === undefined ? "GET" : "POST") {
    const res = await fetch(`${baseUrl}${reqPath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* HTML page etc. */
    }
    return { status: res.status, json };
  }
  return { api };
}

// ---------------------------------------------------------------------------
// DB helper
// ---------------------------------------------------------------------------
let pgClient = null;
async function q(text, params = []) {
  if (!pgClient) {
    const { default: pg } = await import("pg");
    pgClient = new pg.Client(DATABASE_URL);
    await pgClient.connect();
  }
  return (await pgClient.query(text, params)).rows;
}

function sign(body) {
  // Paystack's documented webhook scheme: HMAC-SHA512 of the raw body,
  // keyed with the secret key, hex-encoded.
  return createHmac("sha512", ACTIVE_SECRET).update(body).digest("hex");
}
async function webhook(baseUrl, body, sig) {
  const res = await fetch(`${baseUrl}/api/payments/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sig ? { "x-paystack-signature": sig } : {}) },
    body,
  });
  return res.status;
}
const chargeEvent = (event, ref) => JSON.stringify({ event, data: { reference: ref } });

async function createOrder(client, planLabel) {
  const { status, json } = await client.api("/api/checkout", {
    network: "MTN",
    category: "up2u",
    planLabel,
    recipient: "0244000111",
  });
  if (status !== 200 || !json?.ok) {
    throw new Error(`checkout init failed: HTTP ${status} ${JSON.stringify(json)}`);
  }
  return json; // { ref, authorizationUrl, amount, currency, planLabel }
}
async function verifyOrder(client, ref) {
  const { json } = await client.api("/api/checkout/verify", { ref });
  return json?.order ?? null;
}
async function registerAccount(client, tag) {
  const uniq = Date.now().toString(36);
  const { status, json } = await client.api("/api/auth/register", {
    name: "E2E Tester",
    email: `e2e-${tag}-${uniq}@example.com`,
    phone: `024${String(Date.now()).slice(-7)}`,
    password: "Password123!e2e",
  });
  return { status, json };
}

async function dbOrder(ref) {
  const rows = await q(
    "select payment_status, order_status, fulfillment_status, amount_subunits, currency, " +
      "paystack_transaction_id, paid_at, verified_at, fulfilled_at, failed_at, abandoned_at, provider_message " +
      "from checkout_orders where ref=$1",
    [ref],
  );
  return rows[0] ?? null;
}
async function ledgerCount(ref) {
  const rows = await q("select count(*)::int as n from transactions where ref=$1", [ref]);
  return rows[0]?.n ?? 0;
}
function notSettled(o) {
  return Boolean(o) && o.paymentStatus !== "successful" && o.orderStatus !== "fulfilled";
}

// ---------------------------------------------------------------------------
// Phase A — REAL Paystack TEST API (no browser)
// ---------------------------------------------------------------------------
async function phaseAReal() {
  console.log(`\n=== PHASE A: real Paystack TEST API (${APP_URL_A}) ===`);
  // If an app is already running on the port (e.g. started by the workflow),
  // reuse it instead of spawning a second instance.
  let reused = false;
  try {
    if ((await fetch(`${APP_URL_A}/api/health`)).ok) reused = true;
  } catch {}
  if (reused) {
    info("A0. reusing already-running app on the phase-A port", `${APP_URL_A}/api/health is already healthy`);
  } else {
    spawnApp("app-real", PORT_A);
    await waitFor(`${APP_URL_A}/api/health`, "real-phase app");
  }
  const app = makeClient(APP_URL_A);

  try {
    // A1. Fresh account (also triggers the shared-catalog seed on first run).
    const reg = await registerAccount(app, "a");
    if (!assert("A1. register test account", reg.status === 200 && reg.json?.ok, `HTTP ${reg.status}`)) {
      return;
    }
    const unauth = await makeClient(APP_URL_A).api("/api/checkout", {
      network: "MTN",
      category: "up2u",
      planLabel: "1GB",
      recipient: "0244000111",
    });
    assert("A2. checkout requires authentication", unauth.status === 401, `HTTP ${unauth.status}`);

    // A3. Order creation → REAL Paystack initialize (secret key, server-side).
    const order = await createOrder(app, "1GB");
    assert("A3a. order created with unique reference", /^CO-/.test(order.ref), order.ref);
    assert("A3b. amount + currency resolved server-side", order.amount === 4.5 && order.currency === "GHS", `${order.amount} ${order.currency}`);
    const authHost = new URL(order.authorizationUrl).host;
    assert("A3c. REAL Paystack TEST API initialized the charge", authHost === EXPECT_CHECKOUT_HOST, authHost);

    // A4. Environment probe — informational ONLY.
    // checkout.paystack.com is behind a WAF that blocks datacenter networks;
    // GitHub Actions runners get 403. That is an environment restriction, so
    // we record it and move on instead of failing the suite.
    let probe;
    try {
      probe = await fetch(order.authorizationUrl, { redirect: "manual" });
    } catch {
      probe = null;
    }
    if (probe?.ok) {
      info("A4. hosted checkout reachable from this network", `HTTP ${probe.status} — browser-based payment is possible here`);
    } else if (probe?.status === 403) {
      info(
        "A4. hosted checkout BLOCKED from this network (environment restriction)",
        "HTTP 403 — Paystack's WAF refuses datacenter/CI clients (GitHub Actions). " +
          "This does not indicate an application failure; the full payment flow is covered by the local stub in Phase B.",
      );
    } else {
      info(
        "A4. hosted checkout unreachable from this network (environment restriction)",
        probe ? `HTTP ${probe.status}` : "network error",
      );
    }

    // A5. An unpaid charge must stay unsettled (pending / never-paid).
    let o = await verifyOrder(app, order.ref);
    assert("A5a. unpaid charge stays unsettled (real Paystack says not paid)", notSettled(o), `${o?.paymentStatus}/${o?.orderStatus}`);
    assert("A5b. no fulfillment submitted for an unpaid charge", (await ledgerCount(order.ref)) === 0, `ledger rows: ${await ledgerCount(order.ref)}`);

    // A6. Poll for a while: nothing may change without a verified payment.
    await new Promise((r) => setTimeout(r, REAL_POLL_MS));
    o = await verifyOrder(app, order.ref);
    assert("A6. still unsettled after polling", notSettled(o), `${o?.paymentStatus}/${o?.orderStatus}`);
    assert("A6b. still zero fulfillments after polling", (await ledgerCount(order.ref)) === 0, `ledger rows: ${await ledgerCount(order.ref)}`);

    // A7. Order is private to its owner.
    const other = makeClient(APP_URL_A);
    const regB = await registerAccount(other, "b");
    assert("A7a. second account registered", regB.status === 200 && regB.json?.ok, `HTTP ${regB.status}`);
    const foreign = await other.api("/api/checkout/verify", { ref: order.ref });
    assert("A7b. another account cannot read the order", foreign.status === 404, `HTTP ${foreign.status}`);

    // A8. Webhook security — signed with the REAL test secret.
    const body = chargeEvent("charge.success", order.ref);
    assert("A8a. webhook with bad signature rejected", (await webhook(APP_URL_A, body, "f".repeat(128))) === 401);
    assert("A8b. webhook with no signature rejected", (await webhook(APP_URL_A, body, null)) === 401);
    const tampered = chargeEvent("charge.success", "CO-NOTREAL");
    assert("A8c. webhook with signature over a DIFFERENT body rejected", (await webhook(APP_URL_A, body, sign(tampered))) === 401);
    assert("A8d. webhook with valid signature accepted", (await webhook(APP_URL_A, body, sign(body))) === 200);
    o = await verifyOrder(app, order.ref);
    assert("A8e. valid webhook for an UNPAID charge does not settle it", notSettled(o), `${o?.paymentStatus}/${o?.orderStatus}`);
    assert("A8f. webhook for an unpaid charge still submitted no fulfillment", (await ledgerCount(order.ref)) === 0, `ledger rows: ${await ledgerCount(order.ref)}`);
    const unknown = chargeEvent("charge.success", "CO-DOESNOTEXIST");
    assert("A8g. valid webhook for unknown reference is ignored (200)", (await webhook(APP_URL_A, unknown, sign(unknown))) === 200);

    // A9. No secret material in any captured API response.
    const spot = JSON.stringify([order, o]);
    assert("A9. no secret material in API responses", !spot.includes("sk_test") && !spot.includes(ACTIVE_SECRET));

    // A10. Optional: real hosted checkout with the official test card.
    // Only attempted when explicitly enabled on a network where the page is
    // reachable (local machines). In CI the WAF 403s it, so it is skipped.
    if (process.env.E2E_TRY_HOSTED_CHECKOUT === "1" && probe?.ok) {
      await hostedCheckoutPayment(order, app);
    } else {
      info("A10. hosted-checkout card payment not attempted", process.env.E2E_TRY_HOSTED_CHECKOUT === "1" ? "page not reachable from here" : "opt-in only (E2E_TRY_HOSTED_CHECKOUT=1)");
    }
  } finally {
    if (!reused) stopApp();
  }
}

/** Stop the most recent app child (phase isolation). */
function stopApp() {
  const last = children[children.length - 1];
  if (last) last.child.kill("SIGTERM");
}

// ---------------------------------------------------------------------------
// Optional real-card payment on the hosted page (local opt-in)
// ---------------------------------------------------------------------------
async function hostedCheckoutPayment(order, app) {
  let puppeteer;
  try {
    ({ default: puppeteer } = await import("puppeteer"));
  } catch {
    info("A10. puppeteer not installed — skipping hosted card payment", "run `npm i --no-save puppeteer` to enable it locally");
    return;
  }
  const CARD_SUCCESS = { number: "4084084084084081", cvv: "408", exp: "1230" };
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto(order.authorizationUrl, { waitUntil: "networkidle2", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 4000));
    const roots = [page, ...page.frames()];
    async function findInput(patterns) {
      for (const root of roots) {
        const handles = await root.$$("input").catch(() => []);
        for (const h of handles) {
          const meta = await h.evaluate((el) =>
            [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete].join(" ").toLowerCase(),
          );
          if (patterns.some((p) => meta.includes(p))) return h;
        }
      }
      return null;
    }
    const num = await findInput(["card number", "cardnumber", "number", "cc-number"]);
    const exp = await findInput(["expiry", "mm / yy", "mm/yy", "cc-exp"]);
    const cvv = await findInput(["cvv", "cvc", "cc-csc"]);
    if (!num || !exp || !cvv) {
      await page.screenshot({ path: `e2e-checkout-${Date.now()}.png` }).catch(() => {});
      info("A10. hosted checkout card fields not found — skipping (page layout may have changed)");
      return;
    }
    await num.type(CARD_SUCCESS.number, { delay: 25 });
    await exp.type(CARD_SUCCESS.exp, { delay: 25 });
    await cvv.type(CARD_SUCCESS.cvv, { delay: 25 });
    let clicked = false;
    for (const root of roots) {
      clicked = await root
        .evaluate(() => {
          const btn = [...document.querySelectorAll("button")].find((b) => /^pay/i.test(b.textContent.trim()));
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
      if (clicked) break;
    }
    if (!clicked) {
      info("A10. pay button not found — skipping hosted card payment");
      return;
    }
    await new Promise((r) => setTimeout(r, 15_000));
    const o = await verifyOrder(app, order.ref);
    // Informational on purpose: the suite must never fail on the hosted page.
    record(
      "A10. hosted checkout real test-card payment",
      o?.paymentStatus === "successful",
      `${o?.paymentStatus}/${o?.orderStatus}`,
      "info",
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Phase B — full money flow against the local stub
// ---------------------------------------------------------------------------
async function phaseBStub() {
  console.log(`\n=== PHASE B: full money flow via local Paystack stub (${STUB_URL}) ===`);
  const stub = spawnStub();
  await waitFor(`${STUB_URL}/_stub/health`, "paystack stub");

  spawnApp("app-stub", PORT_B, {
    PAYSTACK_BASE_URL: STUB_URL,
    DATA_MOCK_RESULT: "successful",
  });
  await waitFor(`${APP_URL_B}/api/health`, "stub-phase app");
  const app = makeClient(APP_URL_B);

  try {
    const reg = await registerAccount(app, "b");
    if (!assert("B1. register test account (stub phase)", reg.status === 200 && reg.json?.ok, `HTTP ${reg.status}`)) return;

    // B2. SUCCESS: pay on the (stub) checkout page → verify → settle → fulfil.
    const order = await createOrder(app, "1GB");
    const stubHost = new URL(order.authorizationUrl).host;
    assert("B2a. order initialized against the local stub", stubHost === `127.0.0.1:${STUB_PORT}`, stubHost);
    const pageRes = await fetch(order.authorizationUrl).catch(() => null);
    assert("B2b. stub checkout page reachable via authorization URL", pageRes?.ok === true, `HTTP ${pageRes?.status}`);

    const coRows = await q("select user_id, wallet_id from checkout_orders where ref=$1", [order.ref]);
    const walletId = coRows[0]?.wallet_id;
    const pointsBefore = (await q("select points from wallets where id=$1", [walletId]))[0]?.points ?? 0;

    // Customer "pays" on the checkout page → Paystack (stub) reports success.
    await stubSetScenario(order.ref, "success");
    const o = await verifyOrder(app, order.ref);
    assert("B2c. verified payment settles the order", o?.paymentStatus === "successful" && o?.orderStatus === "fulfilled", `${o?.paymentStatus}/${o?.orderStatus}`);

    const row = await dbOrder(order.ref);
    assert("B2d. amount + currency recorded and matched", row?.amount_subunits === 450 && row?.currency === "GHS", `${row?.amount_subunits} pesewas ${row?.currency}`);
    assert("B2e. Paystack transaction id + paid/verified/fulfilled stamps stored", Boolean(row?.paystack_transaction_id && row?.paid_at && row?.verified_at && row?.fulfilled_at));
    const led = await q("select status, points from transactions where ref=$1", [order.ref]);
    assert("B2f. exactly one fulfillment submission (ledger)", led.length === 1 && led[0]?.status === "successful", `rows: ${led.length}, status: ${led[0]?.status}`);
    assert("B2g. loyalty points credited for the purchase", led[0]?.points === 9, `points: ${led[0]?.points}`);
    const pointsAfter = (await q("select points from wallets where id=$1", [walletId]))[0]?.points ?? 0;
    assert("B2h. wallet balance/points updated consistently", pointsAfter - pointsBefore === 9, `+${pointsAfter - pointsBefore} points`);

    // B3. WEBHOOK-FIRST settlement: the webhook lands before the customer
    // returns from Paystack. Pending → still unsettled; then success → settle.
    const o2 = await createOrder(app, "2GB");
    await stubSetScenario(o2.ref, "pending");
    assert("B3a. webhook accepted while charge is pending", (await webhook(APP_URL_B, chargeEvent("charge.success", o2.ref), sign(chargeEvent("charge.success", o2.ref)))) === 200);
    let o2v = await verifyOrder(app, o2.ref);
    assert("B3b. pending charge not settled from webhook hint", notSettled(o2v), `${o2v?.paymentStatus}/${o2v?.orderStatus}`);
    await stubSetScenario(o2.ref, "success");
    assert("B3c. webhook after charge succeeds", (await webhook(APP_URL_B, chargeEvent("charge.success", o2.ref), sign(chargeEvent("charge.success", o2.ref)))) === 200);
    o2v = await verifyOrder(app, o2.ref);
    assert("B3d. webhook-driven settlement completes + fulfils", o2v?.paymentStatus === "successful" && o2v?.orderStatus === "fulfilled", `${o2v?.paymentStatus}/${o2v?.orderStatus}`);
    const o2v2 = await verifyOrder(app, o2.ref); // customer returns from Paystack
    assert("B3e. verify after webhook is idempotent (no double fulfil)", o2v2?.orderStatus === "fulfilled" && (await ledgerCount(o2.ref)) === 1, `ledger rows: ${await ledgerCount(o2.ref)}`);

    // B4. DUPLICATE webhooks: replayed events must not change state or re-send.
    const before = JSON.stringify(await q("select payment_status, order_status, fulfillment_status, paid_at, verified_at, fulfilled_at, paystack_transaction_id from checkout_orders where ref=$1", [order.ref]));
    for (let i = 0; i < 4; i++) {
      await webhook(APP_URL_B, chargeEvent("charge.success", order.ref), sign(chargeEvent("charge.success", order.ref)));
    }
    const after = JSON.stringify(await q("select payment_status, order_status, fulfillment_status, paid_at, verified_at, fulfilled_at, paystack_transaction_id from checkout_orders where ref=$1", [order.ref]));
    assert("B4. duplicate webhooks are idempotent", before === after && (await ledgerCount(order.ref)) === 1, `ledger rows: ${await ledgerCount(order.ref)}`);

    // B5. AMOUNT MISMATCH: a "successful" charge with the wrong amount must
    // never settle, even when a signed webhook arrives.
    const o3 = await createOrder(app, "1GB");
    await stubSetScenario(o3.ref, "success-wrong-amount");
    let o3v = await verifyOrder(app, o3.ref);
    assert("B5a. amount mismatch parks the order as payment_failed", o3v?.paymentStatus === "failed" && o3v?.orderStatus === "payment_failed", `${o3v?.paymentStatus}/${o3v?.orderStatus}`);
    assert("B5b. amount mismatch → zero fulfillments", (await ledgerCount(o3.ref)) === 0, `ledger rows: ${await ledgerCount(o3.ref)}`);
    await webhook(APP_URL_B, chargeEvent("charge.success", o3.ref), sign(chargeEvent("charge.success", o3.ref)));
    o3v = await verifyOrder(app, o3.ref);
    assert("B5c. signed webhook cannot force a mismatched charge to settle", o3v?.paymentStatus === "failed" && (await ledgerCount(o3.ref)) === 0, `${o3v?.paymentStatus}`);

    // B6. CURRENCY MISMATCH.
    const o4 = await createOrder(app, "1GB");
    await stubSetScenario(o4.ref, "success-wrong-currency");
    const o4v = await verifyOrder(app, o4.ref);
    assert("B6. currency mismatch parks the order as payment_failed", o4v?.paymentStatus === "failed" && o4v?.orderStatus === "payment_failed" && (await ledgerCount(o4.ref)) === 0, `${o4v?.paymentStatus}/${o4v?.orderStatus}`);

    // B7. FAILED payment (declined card).
    const o5 = await createOrder(app, "1GB");
    await stubSetScenario(o5.ref, "failed");
    const o5v = await verifyOrder(app, o5.ref);
    assert("B7a. declined card → payment_failed", o5v?.paymentStatus === "failed" && o5v?.orderStatus === "payment_failed", `${o5v?.paymentStatus}/${o5v?.orderStatus}`);
    assert("B7b. failed payment → zero fulfillments", (await ledgerCount(o5.ref)) === 0, `ledger rows: ${await ledgerCount(o5.ref)}`);

    // B8. ABANDONED checkout (customer closed the page).
    const o6 = await createOrder(app, "1GB");
    await stubSetScenario(o6.ref, "abandoned");
    const o6v = await verifyOrder(app, o6.ref);
    assert("B8a. abandoned checkout → order abandoned", o6v?.paymentStatus === "abandoned" && o6v?.orderStatus === "abandoned", `${o6v?.paymentStatus}/${o6v?.orderStatus}`);
    const row6 = await dbOrder(o6.ref);
    assert("B8b. abandoned order carries the abandoned stamp", Boolean(row6?.abandoned_at));
    assert("B8c. abandoned checkout → zero fulfillments", (await ledgerCount(o6.ref)) === 0, `ledger rows: ${await ledgerCount(o6.ref)}`);

    // B9. PENDING: nothing changes until the charge actually resolves.
    const o7 = await createOrder(app, "1GB");
    await stubSetScenario(o7.ref, "pending");
    const o7v = await verifyOrder(app, o7.ref);
    assert("B9a. pending charge stays pending/awaiting_payment", o7v?.paymentStatus === "pending" && o7v?.orderStatus === "awaiting_payment", `${o7v?.paymentStatus}/${o7v?.orderStatus}`);
    assert("B9b. pending charge → zero fulfillments", (await ledgerCount(o7.ref)) === 0, `ledger rows: ${await ledgerCount(o7.ref)}`);

    // B10. RETRY WITHIN THE SAME CHECKOUT: first attempt fails (declined
    // card), customer retries and pays → the order can still settle.
    const o8 = await createOrder(app, "1GB");
    await stubSetScenario(o8.ref, "flip-success", 1);
    const o8a = await verifyOrder(app, o8.ref);
    assert("B10a. first attempt declined → payment_failed", o8a?.paymentStatus === "failed", `${o8a?.paymentStatus}/${o8a?.orderStatus}`);
    const o8b = await verifyOrder(app, o8.ref); // customer retries with another card
    assert("B10b. retry inside same checkout settles + fulfils", o8b?.paymentStatus === "successful" && o8b?.orderStatus === "fulfilled" && (await ledgerCount(o8.ref)) === 1, `${o8b?.paymentStatus}/${o8b?.orderStatus}`);

    // B11. The app really talked to the stub with a test-key-shaped bearer
    // header (server-side auth), and no response contained key material.
    const auditRes = await fetch(`${STUB_URL}/_stub/audit`);
    const audit = await auditRes.json();
    const apiCalls = audit.requests.filter((r) => r.path.startsWith("/transaction/"));
    assert("B11a. app sent Bearer sk_test_-shaped auth headers to the gateway (server-side only)", apiCalls.length > 0 && apiCalls.every((r) => r.authLooksLikeTestKey), `${apiCalls.length} API calls`);
    const spot = JSON.stringify([order, o2, o3, o5v, o6v, o7v, o8b, audit]);
    assert("B11b. no secret material in stub-phase API responses", !spot.includes(ACTIVE_SECRET));
  } finally {
    stopApp();
  }
}

async function stubSetScenario(ref, scenario, failBefore) {
  const res = await fetch(`${STUB_URL}/_stub/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(failBefore != null ? { ref, scenario, failBefore } : { ref, scenario }),
  });
  if (!res.ok) throw new Error(`stub scenario setup failed for ${ref}: HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Phase C — paid, but the data provider failed: park, never auto-retry
// ---------------------------------------------------------------------------
async function phaseCFulfillmentFailure() {
  console.log(`\n=== PHASE C: fulfillment failure parking (mock provider returns failed) ===`);
  await fetch(`${STUB_URL}/_stub/reset`, { method: "POST" }).catch(() => {});
  spawnApp("app-stub-fail", PORT_C, {
    PAYSTACK_BASE_URL: STUB_URL,
    DATA_MOCK_RESULT: "failed",
  });
  await waitFor(`${APP_URL_C}/api/health`, "fulfillment-failure app");
  const app = makeClient(APP_URL_C);

  try {
    const reg = await registerAccount(app, "c");
    if (!assert("C1. register test account (fulfillment-failure phase)", reg.status === 200 && reg.json?.ok, `HTTP ${reg.status}`)) return;

    const order = await createOrder(app, "1GB");
    await stubSetScenario(order.ref, "success");
    const o = await verifyOrder(app, order.ref);
    assert("C2a. payment itself is settled (Paystack side is fine)", o?.paymentStatus === "successful", `${o?.paymentStatus}`);
    assert("C2b. order parked as fulfillment_failed (provider rejected)", o?.orderStatus === "fulfillment_failed" && o?.fulfillmentStatus === "failed", `${o?.orderStatus}/${o?.fulfillmentStatus}`);
    assert("C2c. one ledger row recording the failed submission", (await ledgerCount(order.ref)) === 1, `ledger rows: ${await ledgerCount(order.ref)}`);
    const row = await dbOrder(order.ref);
    assert("C2d. customer sees a support notice, not a crash", Boolean(row?.provider_message?.length), row?.provider_message);

    // No auto-retry: the gateway may have accepted before the error, so an
    // automatic retry could double-send the bundle. Repeated verify/webhook
    // hits must leave the terminal state untouched.
    const o2 = await verifyOrder(app, order.ref);
    const o3 = await verifyOrder(app, order.ref);
    assert("C3. repeated verification does not re-submit (terminal state)", o2?.orderStatus === "fulfillment_failed" && o3?.orderStatus === "fulfillment_failed" && (await ledgerCount(order.ref)) === 1, `ledger rows: ${await ledgerCount(order.ref)}`);
    await webhook(APP_URL_C, chargeEvent("charge.success", order.ref), sign(chargeEvent("charge.success", order.ref)));
    assert("C4. webhook on a parked order changes nothing", (await ledgerCount(order.ref)) === 1, `ledger rows: ${await ledgerCount(order.ref)}`);
  } finally {
    stopApp();
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`E2E starting. Mode: ${REAL ? "real Paystack TEST API + local stub" : "local stub only (offline)"}`);
  console.log(`Key: ${ACTIVE_SECRET.startsWith("sk_test_") ? "sk_test_… (test mode confirmed, value hidden)" : "INVALID PREFIX"}`);

  if (REAL) await phaseAReal();
  await phaseBStub();
  await phaseCFulfillmentFailure();

  const tests = results.filter((r) => r.kind === "test");
  const failed = tests.filter((r) => !r.ok);
  const infos = results.filter((r) => r.kind === "info");
  console.log(`\n===== SUMMARY: ${tests.length - failed.length}/${tests.length} assertions passed, ${infos.length} environment notes =====`);
  for (const i of infos) console.log(`  note: ${i.name} — ${i.detail}`);
  if (failed.length) {
    console.log("\nFAILED:");
    for (const f of failed) console.log(`  ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }

  // Deterministic teardown: spawned children keep the parent's event loop
  // alive until they exit, so kill everything (stub, any remaining app
  // instance) before exiting. cleanup() on "exit" is the safety net.
  for (const { child, label } of children) {
    if (child.exitCode == null) {
      try {
        child.kill("SIGTERM");
        console.log(`[e2e] stopped ${label}`);
      } catch {}
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
  if (pgClient) await pgClient.end();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  // Never print env/config in errors.
  console.error("E2E crashed:", e.message);
  process.exit(1);
});
