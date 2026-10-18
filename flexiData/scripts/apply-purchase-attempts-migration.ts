/**
 * Guarded, explicit applier for drizzle/0011_purchase_attempts.sql (durable
 * purchase claims). It is the ONLY supported production path for this table.
 *
 * Why not `drizzle-kit push`: it diffs src/db/schema.ts against the live
 * database in BOTH directions and requests removal of out-of-repo tables.
 * Why not `drizzle-kit migrate`: the journal `when` values are not monotonic
 * (0009 is earlier than 0008), and drizzle applies only entries newer than the
 * last recorded migration, so a partially migrated database can silently skip
 * 0009. This runner never reads the journal.
 *
 * Safety model (fail-closed):
 *   1. The DATABASE_URL must be explicit in the environment. No .env is loaded.
 *   2. STATIC AUDIT of the SQL file before connecting: exactly the four
 *      statements that create purchase_attempts, its checks and indexes, and
 *      FKs to transactions/wallets. Any DROP/UPDATE/DELETE/INSERT/ALTER/etc.
 *      aborts.
 *   3. PREFLIGHT (read-only catalog): table absent, or identical to 0011. Any
 *      drifted table, leftover purchase_attempt_* object, or missing parent
 *      column aborts. Row fingerprints of wallets/transactions are recorded.
 *   4. APPLY requires --expect-database=<name> matching current_database().
 *      DDL and full catalog verification run in ONE transaction with
 *      lock_timeout; negative probes (CHECK and FK violations) run inside
 *      savepoints. Any failure rolls back everything.
 *   5. Fingerprints must be unchanged after the commit.
 *
 * Usage (from flexiData/):
 *   DATABASE_URL='postgresql://…' npm run migrate:purchase-attempts -- --dry-run
 *   DATABASE_URL='postgresql://…' npm run migrate:purchase-attempts -- --apply --expect-database=<name>
 *   DATABASE_URL='postgresql://…' npm run migrate:purchase-attempts -- --verify-only
 *
 * Exit codes: 0 success / already-current / dry-run complete; 1 refused or failed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

export const MIGRATION_FILE = resolve(__dirname, "../drizzle/0011_purchase_attempts.sql");

/** Tables/columns the migration references or the durable lifecycle writes. */
const REQUIRED_PARENT_COLUMNS: Record<string, string[]> = {
  transactions: [
    "ref", "wallet_id", "type", "status", "fulfillment_status", "direction", "title", "subtitle",
    "amount", "points", "network", "recipient", "provider", "provider_product_code", "provider_reference",
    "provider_status", "fulfillment_attempts", "charged_at", "fulfilled_at", "refunded_at",
    "last_provider_sync_at",
  ],
  wallets: ["id", "user_id", "balance", "points"],
};

/** Expected physical definition of purchase_attempts (name, type, nullable). */
export const EXPECTED_COLUMNS: [string, string, boolean][] = [
  ["ref", "character varying", false],
  ["wallet_id", "integer", false],
  ["request_key", "character varying", false],
  ["fingerprint", "character varying", false],
  ["request", "jsonb", false],
  ["float_reserved", "boolean", false],
  ["source", "character varying", false],
  ["provider", "character varying", false],
  ["state", "character varying", false],
  ["provider_reference", "character varying", true],
  ["poll_count", "integer", false],
  ["next_poll_at", "timestamp with time zone", false],
  ["lease_until", "timestamp with time zone", true],
  ["lease_token", "uuid", true],
  ["updated_at", "timestamp with time zone", false],
];

/** The ONLY statements the migration may contain, normalized (lowercase,
 * single spaces, comments removed). Any change to 0011 must change this list
 * deliberately. */
const ALLOWED_STATEMENT_PREFIXES = [
  "create table purchase_attempts (",
  "create unique index purchase_attempt_wallet_key on purchase_attempts(wallet_id,request_key)",
  "create unique index purchase_attempt_provider_reference on purchase_attempts(provider,provider_reference) where provider_reference is not null",
  "create index purchase_attempt_due on purchase_attempts(next_poll_at) where state in ('submitted','pending','unknown')",
];
const ALLOWED_REFERENCE_TARGETS = ["transactions", "wallets"];
const FORBIDDEN_TOKENS = [
  "drop", "truncate", "delete", "insert", "update", "alter", "rename", "grant", "revoke",
  "trigger", "function", "copy", "execute", "do", "cascade", "begin", "commit", "rollback",
  "savepoint", "set", "reset", "security", "role", "authorization", "schema", "database",
  "extension", "view", "rule", "policy", "temp", "temporary", "unlogged", "sequence",
];

function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Pure static audit. Returns the list of problems; empty means the SQL is
 * exactly the reviewed additive shape. Exported for the networkless verifier.
 */
export function auditPurchaseAttemptsSql(sql: string): string[] {
  const problems: string[] = [];
  const normalized = normalizeSql(sql);
  const statements = normalized.split(";").map(s => s.trim()).filter(Boolean);
  for (const token of FORBIDDEN_TOKENS) {
    if (new RegExp(`(^|[^a-z_])${token}([^a-z_]|$)`).test(statements.join(" ; "))) {
      problems.push(`contains forbidden keyword "${token}"`);
    }
  }
  for (const statement of statements) {
    if (!ALLOWED_STATEMENT_PREFIXES.some(prefix => statement.startsWith(prefix))) {
      problems.push(`unexpected statement: ${statement.slice(0, 60)}…`);
    }
  }
  if (statements.length !== ALLOWED_STATEMENT_PREFIXES.length) {
    problems.push(`expected ${ALLOWED_STATEMENT_PREFIXES.length} statements, found ${statements.length}`);
  }
  for (const match of normalized.matchAll(/references ([a-z_"]+)/g)) {
    const target = match[1].replaceAll('"', "");
    if (!ALLOWED_REFERENCE_TARGETS.includes(target)) problems.push(`foreign key to unexpected table "${target}"`);
  }
  for (const match of normalized.matchAll(/(?:create table|create (?:unique )?index [a-z_]+ on) ([a-z_]+)/g)) {
    if (match[1] !== "purchase_attempts") problems.push(`creates or indexes unexpected table "${match[1]}"`);
  }
  return problems;
}

type Check = { label: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const note = (label: string, detail = "") => console.log(`  ·     ${label}${detail ? ` — ${detail}` : ""}`);
const record = (label: string, ok: boolean, detail = "") => {
  checks.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

type Mode = "dry-run" | "apply" | "verify-only";

class UsageError extends Error {}

function parseArgs(argv: string[]): { mode: Mode; expectDatabase: string | null } {
  const modeFlags = ["--dry-run", "--verify-only", "--apply"] as const;
  const chosen = modeFlags.filter(m => argv.includes(m));
  const expectArg = argv.find(a => a.startsWith("--expect-database="));
  const expectDatabase = expectArg ? expectArg.slice("--expect-database=".length) : null;
  const unknown = argv.filter(a => !modeFlags.includes(a as (typeof modeFlags)[number]) && !a.startsWith("--expect-database="));
  if (unknown.length > 0 || chosen.length !== 1) {
    throw new UsageError("Usage: exactly one of --dry-run | --verify-only | --apply (apply also needs --expect-database=<name>)");
  }
  const mode: Mode = chosen[0] === "--dry-run" ? "dry-run" : chosen[0] === "--verify-only" ? "verify-only" : "apply";
  return { mode, expectDatabase };
}

/** Catalog state of purchase_attempts relative to 0011. */
async function catalogState(client: Client): Promise<{ state: "absent" | "current" | "drifted"; detail: string[] }> {
  const table = (await client.query("select to_regclass('purchase_attempts') is not null as present")).rows[0].present as boolean;
  const leftovers = (await client.query(
    "select indexname, tablename from pg_indexes where indexname like 'purchase_attempt%' and tablename <> 'purchase_attempts'",
  )).rows;
  if (leftovers.length > 0) {
    return { state: "drifted", detail: leftovers.map(l => `stray object ${l.indexname} on ${l.tablename}`) };
  }
  if (!table) return { state: "absent", detail: [] };
  const problems = await catalogProblems(client);
  return problems.length === 0 ? { state: "current", detail: [] } : { state: "drifted", detail: problems };
}

/** Every structural difference from 0011, by name. Empty = identical shape. */
async function catalogProblems(client: Client): Promise<string[]> {
  const problems: string[] = [];
  const cols = (await client.query(`select column_name, data_type, is_nullable from information_schema.columns
    where table_schema=current_schema() and table_name='purchase_attempts'`)).rows;
  const byName = new Map(cols.map(c => [c.column_name as string, c]));
  for (const [name, type, nullable] of EXPECTED_COLUMNS) {
    const c = byName.get(name);
    if (!c) { problems.push(`missing column ${name}`); continue; }
    if (c.data_type !== type) problems.push(`column ${name} is ${c.data_type}, expected ${type}`);
    if ((c.is_nullable === "YES") !== nullable) problems.push(`column ${name} nullability differs`);
  }
  for (const name of byName.keys()) {
    if (!EXPECTED_COLUMNS.some(([n]) => n === name)) problems.push(`unexpected column ${name}`);
  }
  const constraints = (await client.query(`select conname, contype, convalidated, pg_get_constraintdef(oid) as def
    from pg_constraint where conrelid = to_regclass('purchase_attempts') and contype in ('p','f','c') order by conname`)).rows;
  for (const c of constraints) {
    // NOT VALID constraints are not enforced for pre-existing rows: refuse them.
    if (!c.convalidated) problems.push(`constraint ${c.conname} is NOT VALID`);
  }
  const constraintNames = new Map(constraints.map(c => [c.conname as string, c]));
  const expectConstraint = (name: string, type: string, fragments: string[]) => {
    const c = constraintNames.get(name);
    if (!c) { problems.push(`missing constraint ${name}`); return; }
    if (c.contype !== type) problems.push(`constraint ${name} has wrong type`);
    const def = String(c.def).toLowerCase();
    for (const fragment of fragments) if (!def.includes(fragment)) problems.push(`constraint ${name} definition differs`);
  };
  expectConstraint("purchase_attempts_pkey", "p", ["primary key (ref)"]);
  expectConstraint("purchase_attempt_source", "c", ["source", "'wallet'", "'checkout'"]);
  expectConstraint("purchase_attempt_state", "c", ["state", "'created'", "'submitted'", "'pending'", "'unknown'", "'delivered'", "'failed'"]);
  expectConstraint("purchase_attempt_poll_count", "c", ["poll_count", "0", "12"]);
  const fks = constraints.filter(c => c.contype === "f");
  const fkTargets = fks.map(c => String(c.def).toLowerCase()).sort();
  if (fks.length !== 2 || !fkTargets.some(d => d.includes("references transactions(ref)")) || !fkTargets.some(d => d.includes("references wallets(id)"))) {
    problems.push("foreign keys must reference transactions(ref) and wallets(id)");
  }
  const indexes = (await client.query(`select indexname, indexdef from pg_indexes
    where schemaname=current_schema() and tablename='purchase_attempts' order by indexname`)).rows;
  const indexByName = new Map(indexes.map(i => [i.indexname as string, String(i.indexdef).toLowerCase()]));
  const expectIndex = (name: string, fragments: string[]) => {
    const def = indexByName.get(name);
    if (!def) { problems.push(`missing index ${name}`); return; }
    for (const fragment of fragments) if (!def.includes(fragment)) problems.push(`index ${name} definition differs`);
  };
  expectIndex("purchase_attempt_wallet_key", ["create unique index", "(wallet_id, request_key)"]);
  expectIndex("purchase_attempt_provider_reference", ["create unique index", "(provider, provider_reference)", "where (provider_reference is not null)"]);
  expectIndex("purchase_attempt_due", ["(next_poll_at)", "where ((state)::text = any", "'submitted'", "'unknown'"]);
  return problems;
}

/** Negative probes: CHECK and FK constraints must reject bad rows. Each probe
 * runs inside a savepoint; the whole batch ends in ROLLBACK, so nothing is
 * persisted even if a probe unexpectedly succeeds. Requires an open transaction
 * (callers pass `inTransaction`): the session may be read-only otherwise. */
async function probeConstraints(client: Client): Promise<string[]> {
  const failures: string[] = [];
  const probe = async (label: string, values: string, expectedCode: string) => {
    await client.query("SAVEPOINT purchase_probe");
    try {
      await client.query(`INSERT INTO purchase_attempts (ref,wallet_id,request_key,fingerprint,source,provider,request,state,poll_count)
        VALUES ${values}`);
      failures.push(`${label} was accepted`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== expectedCode) failures.push(`${label} failed with unexpected code ${code ?? "unknown"}`);
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT purchase_probe");
      await client.query("RELEASE SAVEPOINT purchase_probe");
    }
  };
  await probe("invalid state", "('__probe_state__',0,'k','f','wallet','p','{}','bogus',0)", "23514");
  await probe("poll_count above budget", "('__probe_polls__',0,'k','f','wallet','p','{}','created',13)", "23514");
  await probe("unknown source", "('__probe_source__',0,'k','f','mock','p','{}','created',0)", "23514");
  await probe("missing transaction/wallet parent", "('__probe_fk__',0,'k','f','wallet','p','{}','created',0)", "23503");
  return failures;
}

/** Apply path only: probes run inside the migration transaction (see main). */
async function fingerprint(client: Client): Promise<string> {
  const row = (await client.query(`select
      (select md5(coalesce(string_agg(id||':'||balance||':'||points||':'||coalesce(user_id::text,''), ',' order by id), '')) from wallets) as wallets,
      (select md5(coalesce(string_agg(ref||':'||status||':'||fulfillment_status||':'||amount||':'||coalesce(refunded_at::text,''), ',' order by ref), '')) from transactions) as transactions`)).rows[0];
  return `wallets=${row.wallets} transactions=${row.transactions}`;
}

async function preflightParents(client: Client): Promise<string[]> {
  const problems: string[] = [];
  const rows = (await client.query(`select table_name, column_name from information_schema.columns
    where table_schema=current_schema() and table_name = any($1)`, [Object.keys(REQUIRED_PARENT_COLUMNS)])).rows;
  for (const [table, required] of Object.entries(REQUIRED_PARENT_COLUMNS)) {
    const present = new Set(rows.filter(r => r.table_name === table).map(r => r.column_name as string));
    if (present.size === 0) { problems.push(`table ${table} is missing`); continue; }
    for (const column of required) if (!present.has(column)) problems.push(`${table}.${column} is missing`);
  }
  const uniqueRef = (await client.query(`select exists (
      select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
      where i.indrelid = to_regclass('transactions') and i.indisunique and i.indnatts=1 and a.attname='ref') as ok`)).rows[0].ok;
  if (!uniqueRef) problems.push("transactions.ref has no unique constraint (required by the foreign key)");
  const walletPk = (await client.query(`select exists (
      select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
      where i.indrelid = to_regclass('wallets') and i.indisprimary and i.indnatts=1 and a.attname='id') as ok`)).rows[0].ok;
  if (!walletPk) problems.push("wallets.id is not the primary key (required by the foreign key)");
  return problems;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  checks.length = 0;
  const { mode, expectDatabase } = parseArgs(argv);
  const sql = readFileSync(MIGRATION_FILE, "utf8");
  console.log("== Static SQL audit (0011_purchase_attempts.sql)");
  const auditProblems = auditPurchaseAttemptsSql(sql);
  if (auditProblems.length > 0) {
    for (const p of auditProblems) record("SQL audit", false, p);
    return finish(1);
  }
  record("SQL audit: additive purchase_attempts shape only", true);

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL must be set explicitly in the environment (no .env file is read).");
    return 1;
  }
  const target = new URL(url);
  console.log(`== Target ${target.hostname}:${target.port || "5432"} (mode: ${mode})`);

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    if (mode !== "apply") await client.query("SET default_transaction_read_only = on");
    const current = (await client.query("select current_database() as name")).rows[0].name as string;
    console.log(`== Database ${current}`);
    if (mode === "apply") {
      if (!expectDatabase) {
        record("--expect-database=<name> supplied", false, "refusing to apply without explicit target confirmation");
        return finish(1);
      }
      record("--expect-database matches current database", expectDatabase === current);
      if (expectDatabase !== current) return finish(1);
    }

    console.log("== Preflight (read-only)");
    const parentProblems = await preflightParents(client);
    for (const p of parentProblems) record("parent prerequisite", false, p);
    const { state, detail } = await catalogState(client);
    note("purchase_attempts catalog state", state);
    if (state === "drifted") {
      record("purchase_attempts matches migration 0011 (or is absent)", false, detail.slice(0, 4).join("; "));
    }
    if (parentProblems.length > 0 || state === "drifted") {
      note("row fingerprint", "not computed: prerequisites or catalog are not ready");
      return finish(1);
    }
    const before = await fingerprint(client);
    note("row fingerprint before", before);

    if (state === "current") {
      // Read-only by design: no probe writes are attempted against an applied database.
      // Constraint validity (not NOT VALID) and exact definitions were checked above.
      record("catalog matches migration 0011 (constraints validated): already applied, nothing changed", true);
      return finish(0);
    }

    if (mode === "verify-only") {
      record("purchase_attempts is applied", false, "table absent: run --apply first");
      return finish(1);
    }
    if (mode === "dry-run") {
      record("plan", true, "create purchase_attempts with CHECK, unique and partial indexes and FKs to transactions/wallets, in one transaction");
      note("dry run: no DDL executed; the statements are exactly drizzle/0011_purchase_attempts.sql");
      return finish(0);
    }

    // APPLY: DDL and verification in ONE transaction; any failure rolls back.
    await client.query("SET default_transaction_read_only = off");
    await client.query("BEGIN READ WRITE");
    try {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      await client.query(sql);
      record("migration 0011 executed inside one transaction", true);
      const problems = await catalogProblems(client);
      for (const p of problems) record("post-apply catalog", false, p);
      if (problems.length > 0) throw new Error("catalog verification failed");
      record("post-apply catalog matches migration 0011", true);
      const probeFailures = await probeConstraints(client);
      for (const f of probeFailures) record("constraint probe", false, f);
      if (probeFailures.length > 0) throw new Error("constraint probe failed");
      record("CHECK and FK constraints reject invalid rows (rolled back)", true);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      record("transaction rolled back; database unchanged", true, (error as Error).message);
      return finish(1);
    }
    const after = await fingerprint(client);
    record("wallet and transaction fingerprints unchanged", after === before, after === before ? "" : "fingerprint changed");
    note("row fingerprint after", after);
    return finish(after === before ? 0 : 1);
  } finally {
    await client.end();
  }
}

function finish(code: number): number {
  const failed = checks.filter(c => !c.ok).length;
  console.log(`== ${checks.length - failed}/${checks.length} checks passed${code === 0 ? "" : " — NOT READY"}`);
  return code;
}

if (require.main === module) {
  main().then(
    code => { process.exitCode = code; },
    error => {
      // Never print driver messages (may contain connection details).
      if (error instanceof UsageError) console.error(error.message);
      else console.error(`migration runner stopped (${error instanceof Error ? error.name : "Error"}); no further changes were attempted.`);
      process.exitCode = 1;
    },
  );
}
