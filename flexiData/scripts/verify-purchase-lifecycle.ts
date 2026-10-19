/** Real PostgreSQL + synthetic provider responses. NEVER a real provider call.
 * The exact local disposable database name is mandatory; no production URL. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";

async function main() {
  const url = process.env.PURCHASE_TEST_DATABASE_URL;
  if (!url) throw new Error("PURCHASE_TEST_DATABASE_URL required; no DB-free concurrency claim");
  const parsed = new URL(url);
  assert(["localhost", "127.0.0.1"].includes(parsed.hostname));
  assert.equal(parsed.pathname, "/purchase_lifecycle_test");
  process.env.DATABASE_URL = url;
  process.env.DATA_API_PROVIDER = "fixture";
  process.env.DATA_API_BASE_URL = "https://fixture.invalid";
  process.env.DATA_API_AUTH_TYPE = "bearer";
  process.env.DATA_API_TOKEN = "synthetic-only";
  globalThis.fetch = async () => { throw new Error("Unexpected network access"); };
  const database = new Pool({ connectionString: url, max: 20 });
  let checks = 0;
  function pass(name: string) { checks++; console.log(`PASS ${name}`); }
  try {
    // Database must be empty: never drop or overwrite an existing schema.
    assert.equal((await database.query("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")).rows[0].count, "0");
    const schema = execFileSync("npx", ["drizzle-kit", "export", "--sql"], { encoding: "utf8" });
    // Export current baseline without the new table, so the actual migration
    // (not a hand-written approximation) is what creates its constraints.
    const statements = schema.split(/;\s*/).filter(s => s.trim() && !s.includes('"purchase_attempts"'));
    await database.query(statements.join(";\n") + ";");
    await database.query("INSERT INTO wallets (id,name,number,balance) VALUES (1,'Test','0244123456',1000)");
    const before = (await database.query("SELECT balance FROM wallets WHERE id=1")).rows[0].balance;
    await database.query(readFileSync("drizzle/0011_purchase_attempts.sql", "utf8"));
    assert.equal((await database.query("SELECT balance FROM wallets WHERE id=1")).rows[0].balance, before);
    pass("additive migration preserves existing balance");
    const { PurchaseLifecycle, PurchaseConflict, verifiedState } = await import("../src/lib/purchase-lifecycle");
    const lifecycle = new PurchaseLifecycle(database);
    const order = (ref: string) => ({ reference: ref, walletId: 1, network: "MTN" as const,
      recipient: "0244123456", planLabel: "1GB", category: "test", providerProductCode: "fixture", amount: 10 });
    const balance = async () => Number((await database.query("SELECT balance FROM wallets WHERE id=1")).rows[0].balance);
    const result = (id: string | null, state = "accepted", providerCode = "reloadly") => ({
      providerCode, providerReference: id, providerStatus: state,
      status: state === "delivered" ? "successful" as const : state === "rejected" ? "failed" as const : "pending" as const,
      fulfillmentStatus: "processing" as const, providerMessage: null, floatBalance: null, rawRequest: {}, rawResponse: {},
    });
    const claims = await Promise.all(Array.from({ length: 20 }, (_, n) => lifecycle.create(order(`DUP-${n}`), "same-key")));
    assert.equal(claims.filter(c => c.created).length, 1);
    assert.equal(new Set(claims.map(c => c.ref)).size, 1);
    assert.equal(await balance(), 990);
    await assert.rejects(lifecycle.create({ ...order("CONFLICT"), recipient: "0200000000" }, "same-key"), PurchaseConflict);
    pass("20 concurrent duplicate requests: one durable claim, one debit; payload conflicts rejected");
    let sends = 0;
    const ref = claims[0].ref;
    await Promise.all(Array.from({ length: 20 }, () => lifecycle.submit(order(ref), async persisted => {
      sends++;
      assert.equal(persisted.reference, ref);
      const row = (await database.query("SELECT state FROM purchase_attempts WHERE ref=$1", [ref])).rows[0];
      assert.equal(row.state, "submitted");
      assert.equal((await database.query("SELECT status FROM transactions WHERE ref=$1", [ref])).rows[0].status, "pending");
      return result("101", "delivered"); // even this cannot deliver on POST
    })));
    assert.equal(sends, 1);
    assert.equal((await database.query("SELECT state FROM purchase_attempts WHERE ref=$1", [ref])).rows[0].state, "pending");
    pass("durable ledger + submitted claim precede exactly one POST; HTTP/submission success cannot deliver");
    await database.query("UPDATE purchase_attempts SET provider='reloadly' WHERE ref=$1", [ref]);
    // A new service instance simulates process restart, not a new POST.
    const restarted = new PurchaseLifecycle(database);
    process.env.DATA_API_WEBHOOK_SECRET = "synthetic-callback-secret";
    const { POST: callback } = await import("../src/app/api/purchase/callback/route");
    const sendCallback = async (status: string) => {
      const payload = JSON.stringify({ clientReference: ref, providerReference: "101", status });
      const response = await callback(new Request("http://localhost/api/purchase/callback", {
        method: "POST", body: payload, headers: { "content-type": "application/json",
          "x-data-api-signature": createHmac("sha256", process.env.DATA_API_WEBHOOK_SECRET!).update(payload).digest("hex") },
      }));
      assert.equal(response.status, 409);
    };
    let reads = 0;
    await Promise.all([
      ...Array.from({ length: 12 }, () => restarted.reconcile(20, async (_, id) => { reads++; return result(id, "delivered"); })),
      sendCallback("successful"), sendCallback("failed"), sendCallback("successful"),
    ]);
    assert.equal(reads, 1);
    assert.equal(await balance(), 990);
    assert.equal((await database.query("SELECT points FROM wallets WHERE id=1")).rows[0].points, 20);
    pass("restart + 12 polling workers + duplicate/out-of-order callbacks: one read/settlement/points award; callbacks refused");
    await lifecycle.create(order("TIMEOUT"), "timeout");
    await lifecycle.submit(order("TIMEOUT"), async () => { throw new Error("accepted then connection lost"); });
    assert.equal(await balance(), 980);
    assert.equal((await database.query("SELECT state FROM purchase_attempts WHERE ref='TIMEOUT'")).rows[0].state, "unknown");
    await restarted.submit(order("TIMEOUT"), async () => { throw new Error("must not POST again"); });
    assert.equal((await restarted.report()).find(r => r.ref === "TIMEOUT").provider_reference, null);
    pass("timeout after acceptance: durable unknown, no refund, no POST retry, visible without ID");
    // 6.5B: absence of evidence is not a terminal outcome.
    await database.query("UPDATE purchase_attempts SET provider='reloadly' WHERE ref='TIMEOUT'");
    const heldBefore = (await database.query(`SELECT row_to_json(a) AS attempt,
      row_to_json(t) AS ledger FROM purchase_attempts a JOIN transactions t USING(ref)
      WHERE a.ref='TIMEOUT'`)).rows[0];
    const pointsBeforeHold = (await database.query("SELECT points FROM wallets WHERE id=1")).rows[0].points;
    let unsafeCalls = 0;
    await Promise.all(Array.from({ length: 8 }, () => restarted.reconcile(20, async () => {
      unsafeCalls++; throw new Error("No reference means no lookup");
    })));
    await Promise.all(Array.from({ length: 8 }, () => restarted.submit(order("TIMEOUT"), async () => {
      unsafeCalls++; throw new Error("No resubmission allowed");
    })));
    for (const state of ["delivered", "failed"] as const) {
      assert.equal(await restarted.settle("TIMEOUT", "invented-reference", state,
        "00000000-0000-0000-0000-000000000099"), false);
    }
    assert.equal(unsafeCalls, 0);
    assert.deepEqual((await database.query(`SELECT row_to_json(a) AS attempt,
      row_to_json(t) AS ledger FROM purchase_attempts a JOIN transactions t USING(ref)
      WHERE a.ref='TIMEOUT'`)).rows[0], heldBefore);
    assert.equal(await balance(), 980);
    assert.equal((await database.query("SELECT points FROM wallets WHERE id=1")).rows[0].points, pointsBeforeHold);
    pass("6.5B hold invariant: concurrent no-reference review cannot submit, settle, refund, award points or rewrite original outcomes");
    // Synthetic fixture only: not an operator recovery instruction.
    await database.query("UPDATE purchase_attempts SET provider='reloadly',provider_reference='102' WHERE ref='TIMEOUT'");
    await restarted.reconcile(20, async (_, id) => result(id, "delivered"));
    assert.equal(await balance(), 980);
    assert.equal((await database.query("SELECT points FROM wallets WHERE id=1")).rows[0].points, 40);
    pass("late correlated success after ambiguous submission charges once and settles once");
    await lifecycle.create(order("REJECT"), "reject");
    await lifecycle.submit(order("REJECT"), async () => result("103"));
    await database.query("UPDATE purchase_attempts SET provider='reloadly' WHERE ref='REJECT'");
    await Promise.all(Array.from({ length: 10 }, () => restarted.reconcile(20, async (_, id) => result(id, "rejected"))));
    assert.equal(await balance(), 980);
    assert((await database.query("SELECT refunded_at FROM transactions WHERE ref='REJECT'")).rows[0].refunded_at);
    await restarted.reconcile(20, async (_, id) => result(id, "delivered"));
    assert.equal(await balance(), 980);
    pass("definitive rejection: concurrent refund once; terminal replay/out-of-order success cannot settle again");
    await lifecycle.create(order("BAD"), "bad");
    await lifecycle.submit(order("BAD"), async () => result("104"));
    await database.query("UPDATE purchase_attempts SET provider='reloadly' WHERE ref='BAD'");
    await restarted.reconcile(20, async () => result("999", "delivered"));
    assert.equal((await database.query("SELECT state FROM purchase_attempts WHERE ref='BAD'")).rows[0].state, "unknown");
    assert.equal(await balance(), 970);
    for (const status of ["future", "SUCCESSFUL", "FAILED", "not delivered"]) assert.equal(verifiedState(result("104", status)), "unknown");
    pass("mismatched IDs and unknown statuses cannot deliver/refund");

    // Provider-isolated reconciliation fixture: a non-Reloadly adapter can be
    // supplied explicitly without broadening the default poller or interpreting
    // raw provider status strings in the lifecycle.
    await lifecycle.create(order("TECHLINK-MOCK"), "techlink-mock");
    await lifecycle.submit(order("TECHLINK-MOCK"), async () => result("TECHLINK-REF", "accepted", "techlink"));
    await database.query("UPDATE purchase_attempts SET provider='techlink',next_poll_at=now() WHERE ref='TECHLINK-MOCK'");
    let techlinkReads = 0;
    assert.equal(await restarted.reconcileProvider({
      provider: "techlink",
      lookup: async (_, id) => { techlinkReads++; return result(id, "accepted", "techlink"); },
    }), 1);
    assert.equal(techlinkReads, 1);
    assert.equal((await database.query("SELECT state FROM purchase_attempts WHERE ref='TECHLINK-MOCK'")).rows[0].state, "pending");
    await database.query("UPDATE purchase_attempts SET next_poll_at=now() WHERE ref='TECHLINK-MOCK'");
    await restarted.reconcileProvider({
      provider: "techlink",
      lookup: async (_, id) => result(id, "delivered", "techlink"),
    });
    assert.equal((await database.query("SELECT state FROM purchase_attempts WHERE ref='TECHLINK-MOCK'")).rows[0].state, "delivered");
    assert.equal((await database.query("SELECT status FROM transactions WHERE ref='TECHLINK-MOCK'")).rows[0].status, "successful");
    pass("provider-isolated reconciliation accepts an explicit Techlink fixture adapter without changing the default Reloadly poller");

    // Expired lease + stale worker fencing.
    await database.query("UPDATE purchase_attempts SET lease_token='00000000-0000-0000-0000-000000000001',lease_until=now()-interval '1 minute',next_poll_at=now() WHERE ref='BAD'");
    await restarted.reconcile(20, async (_, id) => result(id));
    assert.equal(await restarted.settle("BAD", "104", "delivered", "00000000-0000-0000-0000-000000000001"), false);
    await database.query("UPDATE purchase_attempts SET poll_count=12,next_poll_at=now() WHERE ref='BAD'");
    assert.equal(await restarted.reconcile(20), 0);
    pass("expired lease is reclaimed; stale workers fenced; retry budget exhausted without further calls");
    const pre = await balance();
    await assert.rejects(lifecycle.create({ ...order("POOR"), amount: 5000 }, "poor"));
    assert.equal(await balance(), pre);
    assert.equal((await database.query("SELECT count(*) FROM purchase_attempts WHERE ref='POOR'")).rows[0].count, "0");
    // Force an error after debit: ledger uniqueness conflict must roll debit back.
    await assert.rejects(lifecycle.create(order(ref), "different-key"));
    assert.equal(await balance(), pre);
    pass("insufficient balance and post-debit insert failure roll back claim, ledger and debit");
    await database.query(`INSERT INTO checkout_orders (ref,user_id,wallet_id,customer_email,customer_phone,
      network,category,plan_label,provider_product_code,recipient,amount,amount_subunits,payment_status,order_status)
      VALUES ('CHECKOUT',1,1,'test@example.invalid','0244123456','MTN','test','1GB','fixture','0244123456',10,1000,'successful','paid')`);
    const checkoutClaims = await Promise.all(Array.from({ length: 10 }, () => lifecycle.create(order("CHECKOUT"), "CHECKOUT", "checkout")));
    assert.equal(checkoutClaims.filter(c => c.created).length, 1);
    assert.equal(await balance(), pre);
    await lifecycle.submit(order("CHECKOUT"), async () => result("105"));
    await database.query("UPDATE purchase_attempts SET provider='reloadly' WHERE ref='CHECKOUT'");
    await restarted.reconcile(20, async (_, id) => result(id, "rejected"));
    assert.equal(await balance(), pre);
    assert.equal((await database.query("SELECT order_status FROM checkout_orders WHERE ref='CHECKOUT'")).rows[0].order_status, "fulfillment_failed");
    pass("10 checkout claims: one ledger, no wallet debit; external-payment rejection cannot refund wallet");
    // Simulate crash after submitted commit but before reference persistence.
    await lifecycle.create(order("CRASH"), "crash");
    await database.query("UPDATE purchase_attempts SET state='submitted' WHERE ref='CRASH'");
    await restarted.submit(order("CRASH"), async () => { throw new Error("must never resubmit"); });
    assert((await restarted.report()).find(r => r.ref === "CRASH"));
    pass("crash after submitted commit: restart retains evidence, parks without provider ID");
    await lifecycle.create(order("CREATED-CRASH"), "created-crash");
    const createdReplay = await restarted.create(order("CREATED-CRASH-RETRY"), "created-crash");
    assert.equal(createdReplay.created, false);
    assert.equal(createdReplay.ref, "CREATED-CRASH");
    assert.equal((await database.query("SELECT state FROM purchase_attempts WHERE ref='CREATED-CRASH'")).rows[0].state, "created");
    pass("crash in created state: debit/ledger survive and customer retry cannot resubmit");
    await database.query("UPDATE purchase_attempts SET poll_count=0,next_poll_at=now() WHERE ref='BAD'");
    const outageBalance = await balance();
    await restarted.reconcile(20, async () => { throw new Error("synthetic status outage"); });
    assert.equal(await balance(), outageBalance);
    assert.equal((await database.query("SELECT state FROM purchase_attempts WHERE ref='BAD'")).rows[0].state, "unknown");
    assert.equal(await restarted.reconcile(20), 0); // backoff, no fetch
    pass("status outage preserves charge, records unknown and backs off without immediate repeated reads");
    const preMissing = await balance();
    await database.query("ALTER TABLE purchase_attempts RENAME TO unavailable_purchase_attempts");
    await assert.rejects(lifecycle.create(order("NO-MIGRATION"), "no-migration"));
    assert.equal(await balance(), preMissing);
    assert.equal((await database.query("SELECT count(*) FROM transactions WHERE ref='NO-MIGRATION'")).rows[0].count, "0");
    await database.query("ALTER TABLE unavailable_purchase_attempts RENAME TO purchase_attempts");
    pass("missing migration fails closed: no debit and no ledger fallback");
    const b = await balance();
    await lifecycle.create(order("REFUND-CRASH"), "refund-crash");
    await lifecycle.submit(order("REFUND-CRASH"), async () => result("106"));
    const token = "00000000-0000-0000-0000-000000000002";
    await database.query("UPDATE purchase_attempts SET lease_token=$1 WHERE ref='REFUND-CRASH'", [token]);
    await database.query(`CREATE FUNCTION fail_refund() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.ref='REFUND-CRASH' AND NEW.status='failed' THEN RAISE EXCEPTION 'synthetic crash'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_refund BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION fail_refund()`);
    await assert.rejects(restarted.settle("REFUND-CRASH", "106", "failed", token));
    assert.equal(await balance(), b-10);
    assert.equal((await database.query("SELECT state FROM purchase_attempts WHERE ref='REFUND-CRASH'")).rows[0].state, "pending");
    await database.query("DROP TRIGGER fail_refund ON transactions; DROP FUNCTION fail_refund()");
    const winners = await Promise.all(Array.from({length: 20}, () => restarted.settle("REFUND-CRASH", "106", "failed", token)));
    assert.equal(winners.filter(Boolean).length, 1);
    assert.equal(await balance(), b);
    pass("crash mid-refund rolls back balance+claim+ledger; 20 repeated settlements refund exactly once");
    await database.query("INSERT INTO provider_float_balances (provider_code,network,currency,available_balance) VALUES ('fixture','MTN','GHS',15)");
    await lifecycle.create(order("FLOAT"), "float");
    await assert.rejects(lifecycle.create(order("FLOAT-LOW"), "float-low"));
    const float = (await database.query("SELECT available_balance,reserved_balance FROM provider_float_balances WHERE provider_code='fixture'")).rows[0];
    assert.equal(Number(float.available_balance), 5);
    assert.equal(Number(float.reserved_balance), 10);
    await lifecycle.submit(order("FLOAT"), async () => result("107"));
    await database.query("UPDATE purchase_attempts SET lease_token=$1 WHERE ref='FLOAT'", [token]);
    await restarted.settle("FLOAT", "107", "failed", token);
    const released = (await database.query("SELECT available_balance,reserved_balance FROM provider_float_balances WHERE provider_code='fixture'")).rows[0];
    assert.equal(Number(released.available_balance), 15);
    assert.equal(Number(released.reserved_balance), 0);
    pass("generic GHS float reservation/release is atomic; low float rolls back purchase debit");
    await database.query("INSERT INTO users (id,name,email,phone,password_hash,referral_code,referred_by) VALUES (1,'Buyer','buyer@example.invalid','0244000001','synthetic','BUYER',2),(2,'Referrer','ref@example.invalid','0244000002','synthetic','REF',NULL)");
    await database.query("UPDATE wallets SET user_id=1 WHERE id=1; INSERT INTO wallets (id,user_id,name,number) VALUES (2,2,'Referrer','0244000002')");
    await lifecycle.create(order("REWARD"), "reward");
    await lifecycle.submit(order("REWARD"), async () => result("108"));
    await database.query("UPDATE purchase_attempts SET lease_token=$1 WHERE ref='REWARD'", [token]);
    await Promise.all(Array.from({length: 10}, () => restarted.settle("REWARD", "108", "delivered", token)));
    assert.equal(Number((await database.query("SELECT points FROM wallets WHERE user_id=2")).rows[0].points), 150);
    assert.equal((await database.query("SELECT count(*) FROM transactions WHERE type='referral'")).rows[0].count, "1");
    pass("terminal winner atomically awards existing referral reward once and records existing reward ledger");
    await database.query(`INSERT INTO checkout_orders (ref,user_id,wallet_id,customer_email,customer_phone,
      network,category,plan_label,provider_product_code,recipient,amount,amount_subunits,payment_status,order_status)
      VALUES ('CHECKOUT-LATE',1,1,'test@example.invalid','0244123456','MTN','test','1GB','fixture','0244123456',10,1000,'successful','paid')`);
    // Restore fixture float so this separate purchase has sufficient capacity.
    await database.query("UPDATE provider_float_balances SET available_balance=100 WHERE provider_code='fixture'");
    const checkoutBalance = await balance();
    await lifecycle.create(order("CHECKOUT-LATE"), "CHECKOUT-LATE", "checkout");
    await lifecycle.submit(order("CHECKOUT-LATE"), async () => result("109"));
    await database.query("UPDATE purchase_attempts SET lease_token=$1 WHERE ref='CHECKOUT-LATE'", [token]);
    await Promise.all(Array.from({length: 10}, () => restarted.settle("CHECKOUT-LATE", "109", "delivered", token)));
    assert.equal(await balance(), checkoutBalance);
    assert.equal((await database.query("SELECT order_status FROM checkout_orders WHERE ref='CHECKOUT-LATE'")).rows[0].order_status, "fulfilled");
    const summary = await restarted.summary("CHECKOUT-LATE");
    assert.equal(summary.status, "successful");
    assert.equal(summary.pointsEarned, 20);
    assert.equal((await database.query("SELECT count(*) FROM transactions WHERE ref='CHECKOUT-LATE'")).rows[0].count, "1");
    pass("late checkout success updates order/history/summary once without wallet charge or duplicate referral");
    // --- Part 6.4 operational hardening -------------------------------------
    const { ReloadlyConfigurationError } = await import("../src/lib/reloadly");
    const { PurchaseReconcileError, reconcileAttention } = await import("../src/lib/purchase-lifecycle");
    const { describePurchaseAttemptsCompatibility } = await import("../src/lib/schema-compat");
    assert.equal(process.env.RELOADLY_MODE, undefined);
    await database.query(`CREATE FUNCTION fail_iso() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.ref='ISO-A' AND NEW.status='successful' THEN RAISE EXCEPTION 'synthetic settlement failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_iso BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION fail_iso()`);
    for (const ref of ["ISO-A", "ISO-B"]) {
      await lifecycle.create(order(ref), ref);
      await lifecycle.submit(order(ref), async () => result(ref === "ISO-A" ? "112" : "113"));
      await database.query("UPDATE purchase_attempts SET provider='reloadly' WHERE ref=$1", [ref]);
    }
    await assert.rejects(restarted.reconcile(20, async (_, id) => result(id, "delivered")), (error: unknown) =>
      error instanceof PurchaseReconcileError && error.failed === 1 && error.claimed === 2);
    assert.equal((await database.query("SELECT state FROM purchase_attempts WHERE ref='ISO-B'")).rows[0].state, "delivered");
    assert.equal((await database.query("SELECT state FROM purchase_attempts WHERE ref='ISO-A'")).rows[0].state, "pending");
    await database.query("DROP TRIGGER fail_iso ON transactions; DROP FUNCTION fail_iso()");
    await database.query("UPDATE purchase_attempts SET lease_until=now()-interval '1 minute',next_poll_at=now() WHERE ref='ISO-A'");
    assert.equal(await restarted.reconcile(20, async (_, id) => result(id, "delivered")), 1);
    assert.equal((await database.query("SELECT state FROM purchase_attempts WHERE ref='ISO-A'")).rows[0].state, "delivered");
    pass("one failed settlement does not stop the batch; failure is reported, and the row settles once after lease expiry");
    await lifecycle.create(order("POLL-GUARD"), "poll-guard");
    await lifecycle.submit(order("POLL-GUARD"), async () => result("111"));
    await database.query("UPDATE purchase_attempts SET provider='reloadly' WHERE ref='POLL-GUARD'");
    const guardBefore = (await database.query("SELECT poll_count,lease_token,state FROM purchase_attempts WHERE ref='POLL-GUARD'")).rows[0];
    await assert.rejects(restarted.reconcile(20), ReloadlyConfigurationError);
    const guardAfter = (await database.query("SELECT poll_count,lease_token,state FROM purchase_attempts WHERE ref='POLL-GUARD'")).rows[0];
    assert.deepEqual(guardAfter, guardBefore, "misconfigured poll must not claim, consume budget or lease a row");
    pass("default poll without sandbox configuration refuses before claiming: zero budget consumed, no lease");
    await lifecycle.create(order("EXHAUST"), "exhaust");
    await lifecycle.submit(order("EXHAUST"), async () => result("114"));
    await database.query("UPDATE purchase_attempts SET provider='reloadly',state='unknown',poll_count=12 WHERE ref='EXHAUST'");
    const opsSummary = await restarted.reportSummary();
    const attention = reconcileAttention(opsSummary);
    assert.ok(attention.includes("retry_budget_exhausted"), "exhausted BAD must be visible to monitoring");
    assert.ok(attention.includes("unresolved_without_provider_reference"), "CRASH without provider ID must be visible to monitoring");
    assert.equal(opsSummary.truncated, false);
    assert.equal(typeof opsSummary.byState, "object");
    pass("monitoring summary counts exhausted and no-reference rows and classifies attention categories");
    const probe = await describePurchaseAttemptsCompatibility();
    assert.equal(probe.status, "current");
    assert.deepEqual(probe.missing, []);
    pass("health schema probe reports purchase_attempts current");
    const { spawnSync } = await import("node:child_process");
    const cli = (...args: string[]) => spawnSync("npx", ["tsx", "--conditions=react-server", "scripts/reconcile-purchases.ts", ...args], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", timeout: 120_000 });
    const check = cli("--check");
    assert.equal(check.status, 2, check.stdout + check.stderr);
    assert.ok(/retry_budget_exhausted/.test(check.stdout));
    assert.ok(!check.stdout.includes(url) && !/postgresql:\/\//.test(check.stdout), "CLI output must not echo connection data");
    const poll = cli("--poll");
    assert.equal(poll.status, 1, "--poll without sandbox configuration must fail closed");
    assert.equal((await database.query("SELECT poll_count FROM purchase_attempts WHERE ref='POLL-GUARD'")).rows[0].poll_count, guardBefore.poll_count);
    assert.equal(cli("--report", "--check").status, 1, "modes are mutually exclusive");
    pass("CLI: --check exits 2 on attention without echoing connection data; --poll fails closed; ambiguous modes refused");
    console.log(`${checks} real-PostgreSQL scenarios passed; zero provider/payment network calls.`);
  } finally { await database.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
