/**
 * Real PostgreSQL verification of the guarded 0011 applier and its recovery
 * script. Requires a disposable LOCAL database that is EMPTY (same guard as
 * verify:purchase-lifecycle). Never production. Zero provider/payment calls.
 *
 * Drives the actual CLI with subprocesses so exit codes and default-deny
 * behavior are what operators will see. Uses networkless mutation tests for the
 * static SQL audit.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { auditPurchaseAttemptsSql, MIGRATION_FILE } from "./apply-purchase-attempts-migration";

const RUNNER = resolve(__dirname, "apply-purchase-attempts-migration.ts");
const ROLLBACK = resolve(__dirname, "rollback-purchase-attempts-if-empty.sql");
const DB_NAME = "purchase_lifecycle_test";

function runner(url: string, args: string[]) {
  const result = spawnSync("npx", ["tsx", RUNNER, ...args], {
    cwd: resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(!output.includes(url), "runner output must never echo the connection string");
  return { code: result.status, output };
}

async function main() {
  const url = process.env.PURCHASE_TEST_DATABASE_URL;
  if (!url) throw new Error("PURCHASE_TEST_DATABASE_URL required; never a production URL");
  const parsed = new URL(url);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname), "disposable local database only");
  assert.equal(parsed.pathname, `/${DB_NAME}`);
  process.env.DRIZZLE_ALLOW_LOCAL_DB = "1";
  globalThis.fetch = async () => { throw new Error("Unexpected network access"); };

  let checks = 0;
  const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };

  // (A) Networkless static audit with mutations.
  const sql = readFileSync(MIGRATION_FILE, "utf8");
  assert.deepEqual(auditPurchaseAttemptsSql(sql), []);
  const mutations: [string, string][] = [
    ["DROP TABLE wallets", "DROP TABLE wallets;"],
    ["UPDATE on wallets", "UPDATE wallets SET balance=0;"],
    ["DELETE", "DELETE FROM transactions;"],
    ["INSERT", "INSERT INTO wallets (id) VALUES (9);"],
    ["ALTER other table", "ALTER TABLE transactions ADD COLUMN x integer;"],
    ["TRUNCATE", "TRUNCATE purchase_attempts;"],
    ["GRANT", "GRANT ALL ON purchase_attempts TO public;"],
    ["extra table", "CREATE TABLE other_table (id integer);"],
    ["FK to unexpected table", "CREATE TABLE purchase_extra (ref varchar(40) REFERENCES users(id));"],
    ["TRIGGER", "CREATE TRIGGER t BEFORE UPDATE ON purchase_attempts FOR EACH ROW EXECUTE FUNCTION f();"],
    ["drop of index", "DROP INDEX purchase_attempt_due;"],
  ];
  for (const [label, extra] of mutations) {
    assert.ok(auditPurchaseAttemptsSql(`${sql}\n${extra}`).length > 0, `audit must reject: ${label}`);
  }
  // Removing an expected statement is also a change that requires review.
  const withoutDue = sql.replace(/CREATE INDEX purchase_attempt_due[\s\S]*?;/, "");
  assert.ok(auditPurchaseAttemptsSql(withoutDue).length > 0, "audit must reject a missing reviewed statement");
  // Comments are not executable: a documented keyword must not trip the audit.
  assert.deepEqual(auditPurchaseAttemptsSql(`-- DROP TABLE is only described here\n${sql}`), []);
  pass(`static SQL audit accepts reviewed 0011 and rejects ${mutations.length + 1} destructive/unexpected mutations`);

  // (B) Real PostgreSQL. Must be empty: never drop or overwrite an existing schema.
  const database = new Pool({ connectionString: url, max: 4 });
  try {
    assert.equal((await database.query("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")).rows[0].count, "0");
    const schema = execFileSync("npx", ["drizzle-kit", "export", "--sql"], {
      encoding: "utf8", cwd: resolve(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: url, DRIZZLE_ALLOW_LOCAL_DB: "1" },
    });
    // Baseline = repository schema WITHOUT purchase_attempts, so the guarded runner creates it.
    const statements = schema.split(/;\s*/).filter(s => s.trim() && !s.includes('"purchase_attempts"'));
    await database.query(statements.join(";\n") + ";");
    await database.query("INSERT INTO wallets (id,user_id,name,number,balance,points) VALUES (1,NULL,'Test','0244123456',1000,0)");
    await database.query(`INSERT INTO transactions (ref,wallet_id,type,status,direction,title,amount,network,recipient,provider)
      VALUES ('BASE-1',1,'data','pending','out','MTN 1GB Data',10,'MTN','0244123456','fixture')`);
    const fingerprint = async () => JSON.stringify((await database.query(`select
        (select sum(balance)::text from wallets) as balance, (select count(*)::int from transactions) as tx,
        (select sum(amount)::text from transactions) as amount`)).rows[0]);
    const before = await fingerprint();
    const applied = async () => (await database.query("select to_regclass('purchase_attempts') is not null as p")).rows[0].p as boolean;
    assert.equal(await applied(), false);

    // (C) CLI default-deny and dry-run.
    let r = runner(url, ["--dry-run"]);
    assert.equal(r.code, 0, r.output);
    assert.ok(/no DDL executed/.test(r.output));
    assert.equal(await applied(), false);
    pass("dry-run exits 0, reads the catalog only, creates nothing");

    r = runner(url, ["--apply"]);
    assert.equal(r.code, 1); assert.equal(await applied(), false);
    r = runner(url, ["--apply", "--expect-database=some_other_db"]);
    assert.equal(r.code, 1); assert.equal(await applied(), false);
    pass("apply refuses without --expect-database or with a mismatched database; nothing created");

    r = runner(url, ["--verify-only"]);
    assert.equal(r.code, 1); assert.equal(await applied(), false);
    r = runner(url, []);
    assert.equal(r.code, 1, "no mode flag is refused rather than defaulting to apply");
    pass("verify-only on an unapplied database fails; ambiguous invocation refused");

    // (D) Guarded apply.
    r = runner(url, ["--apply", `--expect-database=${DB_NAME}`]);
    assert.equal(r.code, 0, r.output);
    assert.equal(await applied(), true);
    assert.equal(await fingerprint(), before, "wallet/transaction rows must be unchanged by the migration");
    assert.ok(/CHECK and FK constraints reject invalid rows/.test(r.output));
    pass("guarded apply creates purchase_attempts in one transaction with rolled-back constraint probes; wallet/transaction fingerprints unchanged");

    r = runner(url, ["--verify-only"]);
    assert.equal(r.code, 0, r.output);
    r = runner(url, ["--apply", `--expect-database=${DB_NAME}`]);
    assert.equal(r.code, 0, r.output);
    assert.ok(/already applied, nothing changed/.test(r.output));
    assert.ok(!/constraint probe/.test(r.output), "already-applied path must not attempt probe writes");
    assert.equal(await fingerprint(), before);
    pass("verify-only and re-apply are idempotent: already-current, read-only, no DDL and no probe writes");

    // (E) Drift is refused, never repaired automatically.
    await database.query("ALTER TABLE purchase_attempts RENAME COLUMN poll_count TO poll_count_old");
    r = runner(url, ["--verify-only"]);
    assert.equal(r.code, 1); assert.ok(/poll_count/.test(r.output));
    r = runner(url, ["--apply", `--expect-database=${DB_NAME}`]);
    assert.equal(r.code, 1);
    await database.query("ALTER TABLE purchase_attempts RENAME COLUMN poll_count_old TO poll_count");
    r = runner(url, ["--verify-only"]);
    assert.equal(r.code, 0, r.output);
    pass("drifted column is refused by verify and apply without modification; restoring the column recovers");

    await database.query("ALTER TABLE purchase_attempts DROP CONSTRAINT purchase_attempt_state");
    r = runner(url, ["--verify-only"]);
    assert.equal(r.code, 1);
    await database.query("ALTER TABLE purchase_attempts ADD CONSTRAINT purchase_attempt_state CHECK (state IN ('created','submitted','pending','unknown','delivered','failed')) NOT VALID");
    r = runner(url, ["--verify-only"]);
    assert.equal(r.code, 1, "a NOT VALID constraint must be refused");
    await database.query("ALTER TABLE purchase_attempts VALIDATE CONSTRAINT purchase_attempt_state");
    r = runner(url, ["--verify-only"]);
    assert.equal(r.code, 0, r.output);
    pass("missing and NOT VALID CHECK constraints are refused; validated restoration recovers");

    await database.query("CREATE INDEX purchase_attempt_stray ON transactions(network)");
    r = runner(url, ["--verify-only"]);
    assert.equal(r.code, 1);
    await database.query("DROP INDEX purchase_attempt_stray");
    pass("stray purchase_attempt* object outside the table is refused");

    // (F) Recovery guard: refuses non-empty, drops only empty.
    await database.query("INSERT INTO purchase_attempts (ref,wallet_id,request_key,fingerprint,source,provider,request) VALUES ('BASE-1',1,'k','f','wallet','fixture','{}')");
    await assert.rejects(database.query(readFileSync(ROLLBACK, "utf8")), /contains rows/);
    assert.equal(await applied(), true, "non-empty claim table must survive a rollback attempt");
    await database.query("DELETE FROM purchase_attempts");
    await database.query(readFileSync(ROLLBACK, "utf8"));
    assert.equal(await applied(), false);
    await database.query(readFileSync(ROLLBACK, "utf8")); // idempotent when absent
    assert.equal(await fingerprint(), before);
    pass("recovery script refuses a non-empty claim table, drops only when empty, is idempotent, and leaves money rows untouched");

    console.log(`${checks} migration-applier scenarios passed; zero provider/payment network calls.`);
  } finally {
    await database.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
