/**
 * End-to-end test of the FlexiData ⇄ Paystack TEST-mode integration against
 * the REAL Paystack API (api.paystack.co).
 *
 * Designed for CI (GitHub Actions) or any machine with:
 *   - the app running (APP_URL, default http://localhost:3000)
 *   - PAYSTACK_SECRET_KEY in the environment (sk_test_… ONLY — the script
 *     refuses live keys). The key is read from env and NEVER printed.
 *   - DATABASE_URL for direct DB assertions
 *   - optional: puppeteer installed (used to complete the checkout with
 *     Paystack's official test card). Without it, the script prints the
 *     checkout URL and polls so a human can complete the payment.
 *
 * Run: node scripts/paystack-e2e.mjs
 */
import { createHmac } from "node:crypto";
import process from "node:process";

const APP_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SECRET = process.env.PAYSTACK_SECRET_KEY?.trim() ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const MANUAL_WAIT_MS = Number(process.env.E2E_MANUAL_WAIT_MS ?? 180_000);
// Real runs expect Paystack's checkout host; local stub runs may override.
const EXPECT_CHECKOUT_HOST = process.env.E2E_CHECKOUT_HOST ?? "checkout.paystack.com";

// Official Paystack test cards (docs.paystack.com → Testing):
const CARD_SUCCESS = { number: "4084084084084081", cvv: "408", expMonth: "12", expYear: "30" };
const CARD_DECLINED = { number: "4084080000005408", cvv: "001", expMonth: "12", expYear: "30" };

if (!SECRET) {
  console.error("FATAL: PAYSTACK_SECRET_KEY is not set in the environment.");
  process.exit(2);
}
if (!SECRET.startsWith("sk_test_")) {
  console.error("FATAL: refusing to run — PAYSTACK_SECRET_KEY is not a TEST key (sk_test_…).");
  process.exit(2);
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function assert(name, cond, detail = "") {
  record(name, Boolean(cond), detail);
  return Boolean(cond);
}

// --- tiny cookie-jar fetch -------------------------------------------------
let cookies = {};
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const res = await fetch(`${APP_URL}${path}`, {
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
  try { json = await res.json(); } catch { /* HTML page etc. */ }
  return { status: res.status, json };
}

// --- DB helper ---------------------------------------------------------------
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
  return createHmac("sha512", SECRET).update(body).digest("hex");
}

async function webhook(body, sig) {
  const res = await fetch(`${APP_URL}/api/payments/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sig ? { "x-paystack-signature": sig } : {}) },
    body,
  });
  return res.status;
}

async function createOrder(planLabel) {
  const { status, json } = await api("/api/checkout", {
    network: "MTN",
    category: "up2u",
    planLabel,
    recipient: "0244000111",
  });
  if (status !== 200 || !json?.ok) throw new Error(`checkout init failed: HTTP ${status} ${JSON.stringify(json)}`);
  return json; // { ref, authorizationUrl, amount }
}

async function verifyOrder(ref) {
  const { json } = await api("/api/checkout/verify", { ref });
  return json?.order ?? null;
}

async function pollUntil(ref, predicate, timeoutMs, everyMs = 5000) {
  const until = Date.now() + timeoutMs;
  let order = null;
  while (Date.now() < until) {
    order = await verifyOrder(ref);
    if (order && predicate(order)) return order;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return order;
}

// --- Checkout automation (best effort) --------------------------------------
async function payWithCard(url, card) {
  let puppeteer;
  try {
    ({ default: puppeteer } = await import("puppeteer"));
  } catch {
    return { automated: false, reason: "puppeteer not installed" };
  }
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 4000));

    // Paystack checkout renders inside the page or an iframe; search both.
    const roots = [page, ...page.frames()];
    async function findInput(patterns) {
      for (const root of roots) {
        const handles = await root.$$("input").catch(() => []);
        for (const h of handles) {
          const meta = await h.evaluate((el) =>
            [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete]
              .join(" ")
              .toLowerCase(),
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
      return { automated: false, reason: "card fields not found on checkout page" };
    }
    await num.type(card.number, { delay: 25 });
    await exp.type(`${card.expMonth}${card.expYear}`, { delay: 25 });
    await cvv.type(card.cvv, { delay: 25 });

    // Click the pay button (any button whose text starts with "Pay").
    let clicked = false;
    for (const root of roots) {
      clicked = await root.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => /^pay/i.test(b.textContent.trim()));
        if (btn) { btn.click(); return true; }
        return false;
      }).catch(() => false);
      if (clicked) break;
    }
    if (!clicked) return { automated: false, reason: "pay button not found" };

    // Give Paystack time to process / show result.
    await new Promise((r) => setTimeout(r, 15_000));
    return { automated: true };
  } finally {
    await browser.close().catch(() => {});
  }
}

// =============================================================================
async function main() {
  console.log(`E2E against ${APP_URL} using REAL Paystack TEST API (key: sk_test_…hidden)`);

  // 0. Fresh test account.
  const uniq = Date.now().toString(36);
  const reg = await api("/api/auth/register", {
    name: "E2E Tester",
    email: `e2e-${uniq}@example.com`,
    phone: `024${String(Date.now()).slice(-7)}`,
    password: "Password123!e2e",
  });
  if (!assert("0. register test account", reg.status === 200 && reg.json?.ok, `HTTP ${reg.status}`)) return;

  // 1+2+3. Create order → real Paystack initialize → redirect URL.
  const order = await createOrder("1GB");
  assert("1. order created with unique reference", /^CO-/.test(order.ref), order.ref);
  const authHost = new URL(order.authorizationUrl).host;
  assert("2. initialized via real Paystack TEST API", authHost === EXPECT_CHECKOUT_HOST, authHost);
  const pageRes = await fetch(order.authorizationUrl).catch(() => null);
  assert("3. checkout page reachable (redirect target live)", pageRes?.ok === true, `HTTP ${pageRes?.status}`);

  // 11a. Pending: verify before any payment — must not settle.
  let o = await verifyOrder(order.ref);
  assert("11a. unpaid order stays unsettled (pending/abandoned)",
    o && o.paymentStatus !== "successful" && o.orderStatus !== "fulfilled",
    `${o?.paymentStatus}/${o?.orderStatus}`);

  // 4. Complete payment with the official test card.
  const pay = await payWithCard(order.authorizationUrl, CARD_SUCCESS);
  if (!pay.automated) {
    console.log(`>> Browser automation unavailable (${pay.reason}).`);
    console.log(`>> MANUAL STEP: open and pay with test card 4084 0840 8408 4081 (CVV 408, any future expiry):`);
    console.log(`>> ${order.authorizationUrl}`);
    console.log(`>> Waiting up to ${Math.round(MANUAL_WAIT_MS / 60000)} min…`);
  }
  o = await pollUntil(order.ref, (x) => x.paymentStatus === "successful", pay.automated ? 90_000 : MANUAL_WAIT_MS);

  // 5+7+8. Verified with Paystack; amount/currency/ref enforced; settled once.
  const paid = assert("4/5. test payment completed & verified with Paystack",
    o?.paymentStatus === "successful", `${o?.paymentStatus}/${o?.orderStatus}`);

  if (paid) {
    const rows = await q("select payment_status, order_status, amount_subunits, currency, paystack_transaction_id from checkout_orders where ref=$1", [order.ref]);
    assert("7. amount + currency recorded and matched",
      rows[0]?.amount_subunits === Math.round(order.amount * 100) && rows[0]?.currency === "GHS",
      `${rows[0]?.amount_subunits} pesewas ${rows[0]?.currency}`);
    assert("8. settled only after verification", rows[0]?.payment_status === "successful" && rows[0]?.paystack_transaction_id, `tx ${rows[0]?.paystack_transaction_id}`);

    // 9. Exactly one fulfillment (ledger row == gateway submission).
    const led = await q("select count(*)::int as n from transactions where ref=$1", [order.ref]);
    assert("9. exactly one fulfillment submission", led[0]?.n === 1, `ledger rows: ${led[0]?.n}`);

    // 6. Webhook signature verification (signed with the REAL test secret).
    const body = JSON.stringify({ event: "charge.success", data: { reference: order.ref } });
    assert("6a. webhook with bad signature rejected", (await webhook(body, "f".repeat(128))) === 401);
    assert("6b. webhook with no signature rejected", (await webhook(body, null)) === 401);
    assert("6c. webhook with valid signature accepted", (await webhook(body, sign(body))) === 200);

    // 10. Replays: state must not change, no extra fulfillment.
    const before = JSON.stringify(await q("select payment_status, order_status, fulfillment_status, paid_at, verified_at, fulfilled_at from checkout_orders where ref=$1", [order.ref]));
    for (let i = 0; i < 4; i++) await webhook(body, sign(body));
    const after = JSON.stringify(await q("select payment_status, order_status, fulfillment_status, paid_at, verified_at, fulfilled_at from checkout_orders where ref=$1", [order.ref]));
    const led2 = await q("select count(*)::int as n from transactions where ref=$1", [order.ref]);
    assert("10. duplicate webhooks are idempotent", before === after && led2[0]?.n === 1, `ledger rows: ${led2[0]?.n}`);
  }

  // 11b. Failed payment (declined test card).
  const fOrder = await createOrder("2GB");
  const fPay = await payWithCard(fOrder.authorizationUrl, CARD_DECLINED);
  if (fPay.automated) {
    const fo = await pollUntil(fOrder.ref, (x) => x.paymentStatus === "failed", 90_000);
    assert("11b. declined card -> payment_failed, no fulfillment",
      fo?.paymentStatus === "failed" || fo?.paymentStatus === "abandoned",
      `${fo?.paymentStatus}/${fo?.orderStatus}`);
    const fLed = await q("select count(*)::int as n from transactions where ref=$1", [fOrder.ref]);
    assert("11b-2. failed order has zero fulfillments", fLed[0]?.n === 0, `ledger rows: ${fLed[0]?.n}`);
  } else {
    record("11b. declined-card flow", true, "SKIPPED (no browser automation) — cover manually with card 4084 0800 0000 5408");
  }

  // 11c. Abandoned: initialize, open checkout, never pay.
  const aOrder = await createOrder("1GB");
  await fetch(aOrder.authorizationUrl).catch(() => {});
  const ao = await verifyOrder(aOrder.ref);
  assert("11c. unpaid checkout never settles (pending/abandoned)",
    ao && ao.paymentStatus !== "successful" && ao.orderStatus !== "fulfilled",
    `${ao?.paymentStatus}/${ao?.orderStatus}`);
  const aLed = await q("select count(*)::int as n from transactions where ref=$1", [aOrder.ref]);
  assert("11c-2. abandoned order has zero fulfillments", aLed[0]?.n === 0, `ledger rows: ${aLed[0]?.n}`);

  // 12. No secret key in any API response captured above (spot check).
  const spot = JSON.stringify([order, o, ao]);
  assert("12. no secret material in API responses", !spot.includes("sk_test") && !spot.includes(SECRET));

  // Summary.
  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== SUMMARY: ${results.length - failed.length}/${results.length} passed =====`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
  if (pgClient) await pgClient.end();
}

main().catch((e) => {
  // Never print env/config in errors.
  console.error("E2E crashed:", e.message);
  process.exit(1);
});
