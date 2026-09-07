/**
 * Apply the PR #38 audit-schema migration to a live database — explicitly,
 * non-destructively, and WITHOUT `drizzle-kit push`.
 *
 * Why this exists: `drizzle-kit push` diffs src/db/schema.ts against the live
 * database in BOTH directions. The production database carries tables that do
 * not live in the repo schema, so a push for PR #38 turned into a request to
 * DROP unrelated tables, and the migration had to be aborted. This runner
 * applies exactly the two `admin_audit_logs` objects PR #38 needs (widened
 * `admin_audit_logs_action_check` + replay-safe `admin_audit_logs_order_action_idx`,
 * via scripts/sql/pr38-widen-admin-audit-log-actions.sql) and nothing else.
 *
 * Safety model (fail-closed at every layer):
 *   1. STATIC SQL AUDIT — before anything connects, the SQL file is scanned:
 *      any DROP TABLE / TRUNCATE / DELETE / UPDATE / INSERT / DROP COLUMN /
 *      grant/revoke / trigger / COPY … or a statement touching a table other
 *      than `admin_audit_logs` (or a drop that is not the known
 *      constraint/index swap) aborts the run.
 *   2. READ-ONLY PREFLIGHT — catalog state of both objects; a scan proving
 *      every existing `admin_audit_logs` row already satisfies the widened
 *      CHECK; a full-row snapshot of the genuine Paystack deposit
 *      DP-MTMZN2P8SSBR; before/after checksums proving `admin_audit_logs` is
 *      append-only across the run; row counts for wallets / transactions /
 *      deposit_requests / withdrawal_requests; and an inventory of
 *      production-only tables (the ones `drizzle-kit push` wanted to drop —
 *      this migration leaves every one of them alone, by construction).
 *   3. ONE TRANSACTION — the SQL file commits or rolls back whole, with a
 *      5s lock_timeout so a busy table makes it abort instead of stall.
 *   4. POST-VERIFY — re-read the catalog (both objects must now accept the
 *      withdrawal actions), re-check every snapshot from (2), and drive the
 *      EXACT reject/approve audit INSERTs of the action route inside a
 *      transaction that is ROLLED BACK: proof the constraint and the index
 *      accept PR #38's writes, with zero rows persisted.
 *
 * It never drops or truncates a table, never deletes or rewrites a row, never
 * touches wallet balances, withdrawals, or deposit_requests, and refunds
 * nothing. Applying it is the ONLY data-adjacent side effect, and it is DDL
 * on two audit-log objects.
 *
 * Usage (from flexiData/):
 *   DATABASE_URL='postgresql://…' npm run migrate:admin-audit-actions -- --dry-run
 *   DATABASE_URL='postgresql://…' npm run migrate:admin-audit-actions
 *   DATABASE_URL='postgresql://…' npm run migrate:admin-audit-actions -- --verify-only
 *
 * Modes:
 *   (default)    preflight → apply → verify
 *   --dry-run    preflight + printed plan only; connects READ ONLY, no DDL
 *   --verify-only preflight + verify without applying (use after applying the
 *                .sql file by hand with psql)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PROTECTED_REF = "DP-MTMZN2P8SSBR";
const SQL_FILE = resolve(__dirname, "sql/pr38-widen-admin-audit-log-actions.sql");

/** Tables declared by the current src/db/schema.ts (14). Anything else in the
 *  live database is out-of-repo drift: this migration does not touch it —
 *  this is precisely what `drizzle-kit push` would try to DROP. */
const REPO_TABLES = [
  "admin_audit_logs",
  "agent_profiles",
  "bundle_plans",
  "checkout_orders",
  "deposit_requests",
  "password_resets",
  "price_alerts",
  "provider_float_balances",
  "scheduled_topups",
  "sessions",
  "transactions",
  "users",
  "wallets",
  "withdrawal_requests",
];

const WIDENED_ACTIONS = [
  "suspend",
  "activate",
  "delivery_resolved",
  "refund_review",
  "approve_withdrawal",
  "reject_withdrawal",
] as const;
const REPLAY_ACTIONS = ["delivery_resolved", "refund_review", "approve_withdrawal", "reject_withdrawal"] as const;
const FINANCE_TABLES = ["wallets", "transactions", "deposit_requests", "withdrawal_requests"] as const;

function loadEnvFiles(): void {
  // Same precedence as drizzle.config.ts: explicit env wins, then .env.local,
  // then .env. drizzle-kit/tsx do not auto-load .env.local; this is the file
  // the README tells operators to put the production DATABASE_URL in.
  for (const file of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), file);
    try {
      if (process.env.DATABASE_URL === undefined && exists(path)) {
        (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(path);
      }
    } catch {
      /* malformed env file: fall through to the DATABASE_URL error below */
    }
  }
  function exists(p: string): boolean {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Tiny check logger (repo-wide verify-script convention)
// ---------------------------------------------------------------------------
let failures = 0;
let checks = 0;
const ok = (label: string, detail = ""): void => {
  checks += 1;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
};
const bad = (label: string, detail = ""): void => {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
};
const note = (label: string, detail = ""): void => console.log(`  ·     ${label}${detail ? ` — ${detail}` : ""}`);

// ---------------------------------------------------------------------------
// (1) Static audit of the SQL file — a tripwire so a future edit can never
//     turn "the safe migration" into something destructive.
// ---------------------------------------------------------------------------
function auditSql(sql: string): string[] {
  const problems: string[] = [];
  // Strip comments first: the header documents the very keywords ("no DROP
  // TABLE …") that would otherwise trip the tripwires below.
  const lower = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .toLowerCase();
  const forbidden: [RegExp, string][] = [
    [/\bdrop\s+table\b/, "DROP TABLE"],
    [/\btruncate\b/, "TRUNCATE"],
    [/\bdelete\s+from\b/, "DELETE FROM"],
    [/\bupdate\s+[\w".]+\s+set\b/, "UPDATE … SET (row modification)"],
    [/\binsert\s+into\b/, "INSERT INTO (row creation)"],
    [/\bdrop\s+column\b/, "DROP COLUMN"],
    [/\balter\s+table[\s\S]*?\brename\b/, "RENAME"],
    [/\bdrop\s+(schema|database|role|extension|function|type)\b/, "DROP of shared objects"],
    [/\bcreate\s+(rule|trigger|event\s+trigger)\b/, "CREATE RULE/TRIGGER"],
    [/\bcopy\s+[\s\S]{0,40}\bfrom\b/, "COPY … FROM"],
    [/\b(grant|revoke)\b/, "privilege change"],
    [/\bset\s+(session\s+)?authorization\b/, "role switching"],
    [/\bexecute\s+immediate\b/, "prepared DDL bypass"],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(lower)) problems.push(`contains ${label}`);
  }
  // Every ALTER TABLE must target admin_audit_logs…
  for (const m of lower.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(["\w.]+)/g)) {
    const t = m[1].replaceAll('"', "").split(".").pop() as string;
    if (t !== "admin_audit_logs") problems.push(`alters table "${t}" — only admin_audit_logs may be touched`);
  }
  // …and the only permitted drops are the known drop-then-re-add swaps.
  for (const m of lower.matchAll(/\bdrop\s+constraint\s+([\s\S]{0,80}?)(?:;|'|$)/g)) {
    if (!/if\s+exists\s+admin_audit_logs_action_check/.test(m[1].trim().replaceAll("\n", " ")))
      problems.push(`drops an unknown constraint: drop constraint ${m[1].trim().slice(0, 60)}…`);
  }
  for (const m of lower.matchAll(/\bdrop\s+index\s+([\s\S]{0,80}?)(?:;|'|$)/g)) {
    if (!/if\s+exists\s+admin_audit_logs_order_action_idx/.test(m[1].trim().replaceAll("\n", " ")))
      problems.push(`drops an unknown index: drop index ${m[1].trim().slice(0, 60)}…`);
  }
  // The migrated constraint/index must be exactly the widened definitions.
  for (const action of WIDENED_ACTIONS) {
    if (!lower.includes(action)) problems.push(`widened CHECK list is missing "${action}"`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// (2)/(4) Read-only snapshots
// ---------------------------------------------------------------------------
type Catalog = {
  table: boolean;
  checkDef: string | null;
  indexDef: string | null;
  targetRefColumn: boolean;
};
type Snapshot = {
  catalog: Catalog;
  auditCount: number;
  auditPrefixMaxId: number;
  auditPrefixHash: string;
  actionHistogram: Record<string, number>;
  violatingRows: string | null;
  financeCounts: Record<string, number>;
  protectedDeposit: unknown[] | null;
  protectedHash: string;
  driftTables: string[];
  dbIdentity: string;
};

const catalogQuery = `
  select
    (to_regclass('public.admin_audit_logs') is not null) as table,
    (select pg_get_constraintdef(c.oid) from pg_constraint c
       where c.conrelid = to_regclass('public.admin_audit_logs')::oid
         and c.conname = 'admin_audit_logs_action_check' and c.contype = 'c') as "checkDef",
    (select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'admin_audit_logs_order_action_idx') as "indexDef",
    exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='admin_audit_logs'
               and column_name='target_ref') as "targetRefColumn"`;

function stateOf(catalog: Catalog): "missing" | "legacy" | "current" {
  if (!catalog.table) return "missing";
  const widened = (def: string | null, list: readonly string[]): boolean =>
    def !== null && list.every((a) => def.includes(a));
  if (
    widened(catalog.checkDef, WIDENED_ACTIONS) &&
    widened(catalog.indexDef, REPLAY_ACTIONS) &&
    catalog.targetRefColumn
  )
    return "current";
  return "legacy";
}

async function snapshot(db: Client): Promise<Snapshot> {
  const cat = await db.query(catalogQuery);
  const catalog = cat.rows[0] as Catalog;

  let auditCount = 0;
  let auditPrefixMaxId = 0;
  let auditPrefixHash = "-";
  let actionHistogram: Record<string, number> = {};
  let violatingRows: string | null = null;
  const financeCounts: Record<string, number> = {};

  if (catalog.table) {
    const c = await db.query("select count(*)::int as n, coalesce(max(id),0)::int as max_id from admin_audit_logs");
    auditCount = c.rows[0].n as number;
    auditPrefixMaxId = c.rows[0].max_id as number;
    // Checksum of ALL rows existing now; re-checked after the migration with
    // the same id boundary: the audit table is append-only, so any change in
    // this prefix proves the migration modified/deleted rows (it must not).
    const h = await db.query(
      "select coalesce(md5(string_agg(t::text, '|' order by id)),'(empty)') as h from admin_audit_logs t where id <= $1",
      [auditPrefixMaxId],
    );
    auditPrefixHash = h.rows[0].h as string;
    const hist = await db.query("select action, count(*)::int as n from admin_audit_logs group by action order by action");
    for (const r of hist.rows as { action: string; n: number }[]) actionHistogram[r.action] = r.n;
    const v = await db.query(
      `select string_agg(distinct action, ', ') as bad from admin_audit_logs
        where action not in ('${WIDENED_ACTIONS.join("','")}')`,
    );
    violatingRows = v.rows[0].bad as string | null;
  }

  for (const t of FINANCE_TABLES) {
    const r = await db.query(`select count(*)::int as n from ${t}`);
    financeCounts[t] = r.rows[0].n as number;
  }

  let protectedDeposit: unknown[] | null = null;
  const dep = await db.query(
    "select to_regclass('public.deposit_requests') is not null as present",
  );
  if (dep.rows[0].present) {
    const rows = await db.query("select * from deposit_requests where ref = $1 order by id", [PROTECTED_REF]);
    protectedDeposit = rows.rows;
  }
  const protectedHash = hashJson(protectedDeposit);

  const drift = await db.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const driftTables = (drift.rows as { table_name: string }[])
    .map((r) => r.table_name)
    .filter((t) => !REPO_TABLES.includes(t))
    .sort();

  const ident = await db.query(
    "select current_user as u, current_database() as d, inet_server_addr()::text as host, inet_server_port() as port",
  );
  const i = ident.rows[0] as { u: string; d: string; host: string | null; port: number | null };
  const dbIdentity = `${i.u}@${i.host ?? "socket"}:${i.port ?? "-"}/${i.d}`;

  return {
    catalog,
    auditCount,
    auditPrefixMaxId,
    auditPrefixHash,
    actionHistogram,
    violatingRows,
    financeCounts,
    protectedDeposit,
    protectedHash,
    driftTables,
    dbIdentity,
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  loadEnvFiles();
  const mode = process.argv.slice(2).includes("--dry-run")
    ? "dry-run"
    : process.argv.slice(2).includes("--verify-only")
      ? "verify-only"
      : "apply";

  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error(
      "DATABASE_URL is not set. Point it at the database that needs the PR #38 audit\n" +
        "objects — the same precedence the app uses (export wins, then .env.local, .env).\n" +
        "This runner refuses to guess a database, exactly like drizzle.config.ts.",
    );
    process.exit(2);
  }
  if (/pooler|pgbouncer/i.test(url)) {
    note(
      "pooler URL detected",
      "Neon pooled connections can reject DDL — prefer the DIRECT (non-pooled) connection string for this migration",
    );
  }

  console.log(`\npr38 admin-audit migration — mode: ${mode.toUpperCase()}`);
  console.log("scope: widen admin_audit_logs action CHECK + replay-safety index (nothing else)\n");

  // --- (1) static SQL audit (before any connection) --------------------------
  const sqlText = readFileSync(SQL_FILE, "utf8");
  const sqlProblems = auditSql(sqlText);
  if (sqlProblems.length > 0) {
    for (const p of sqlProblems) bad(`SQL safety audit: scripts/sql/pr38-widen-admin-audit-log-actions.sql ${p}`);
    console.error("\nREFUSED: the migration file failed its static safety audit; nothing was attempted.");
    process.exit(2);
  }
  ok("SQL safety audit", "no DROP TABLE/TRUNCATE/DELETE/UPDATE/INSERT, admin_audit_logs only, known swap drops only");

  const db = new Client({ connectionString: url });
  await db.connect();

  let before: Snapshot;
  try {
    // --- (2) read-only preflight --------------------------------------------
    if (mode === "dry-run") await db.query("BEGIN READ ONLY");
    before = await snapshot(db);
    if (mode === "dry-run") await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    bad("preflight could not read the catalog", (error as Error).message.split("\n")[0]);
    await db.end();
    process.exit(2);
  }

  const state = stateOf(before.catalog);
  console.log(`  target database:      ${before.dbIdentity}`);
  console.log(`  admin_audit_logs:     ${state}`);
  console.log(
    `  audit rows:           ${before.auditCount}` +
      (Object.keys(before.actionHistogram).length ? `  (${Object.entries(before.actionHistogram).map(([a, n]) => `${a}:${n}`).join(", ")})` : ""),
  );
  if (before.driftTables.length > 0) {
    note(
      "production-only tables (not in src/db/schema.ts)",
      `${before.driftTables.join(", ")} — untouched by this migration; this is the drift that made drizzle-kit push request destructive table removals`,
    );
  }

  if (state === "missing") {
    bad("preflight", "admin_audit_logs does not exist — the FULL migration set (0000..0007) is required for this database, not this targeted delta. Nothing was changed.");
    await db.end();
    process.exit(2);
  }
  if (before.violatingRows !== null) {
    bad("existing audit rows satisfy the widened CHECK", `offending actions: ${before.violatingRows} — triage first; nothing was changed`);
    await db.end();
    process.exit(2);
  }
  ok("existing audit rows satisfy the widened CHECK", before.violatingRows === null ? "0 violations (constraint swap cannot fail on data)" : "");
  if (before.protectedDeposit !== null) {
    ok(`${PROTECTED_REF} snapshotted before`, `${before.protectedDeposit.length} row(s), hash ${before.protectedHash}`);
  } else {
    note(`${PROTECTED_REF} not present in this database`, "before/after proof applies when the row exists");
  }

  const needsConstraint = !(before.catalog.checkDef && WIDENED_ACTIONS.every((a) => before.catalog.checkDef!.includes(a)));
  const needsIndex = !(before.catalog.indexDef && REPLAY_ACTIONS.every((a) => before.catalog.indexDef!.includes(a)));
  const needsColumn = !before.catalog.targetRefColumn;
  console.log("  plan:");
  console.log(`    ${(needsConstraint ? "APPLY" : "no-op").padEnd(6)}admin_audit_logs_action_check → widened 6-action list`);
  console.log(`    ${(needsIndex ? "APPLY" : "no-op").padEnd(6)}admin_audit_logs_order_action_idx → widened 4-action predicate`);
  console.log(`    ${(needsColumn ? "APPLY" : "no-op").padEnd(6)}ADD COLUMN IF NOT EXISTS target_ref (pre-0003 baselines only)`);

  if (mode === "dry-run") {
    const actionable = needsConstraint || needsIndex || needsColumn;
    console.log(`\nDRY RUN — nothing was executed. ${actionable ? "Changes pending above." : "Database already current; the migration would be a no-op."}`);
    await db.end();
    process.exitCode = 0;
    return;
  }

  // --- (3) apply --------------------------------------------------------------
  if (mode === "verify-only") {
    note("apply", "skipped (--verify-only: DDL was applied out of band; this run only verifies)");
  } else if (state === "current") {
    note("migration", "database is already current — the SQL is guarded and will no-op; applying for completeness");
  }
  if (mode !== "verify-only") {
    try {
      await db.query(sqlText);
      ok("migration applied", "single transaction committed");
    } catch (error) {
      const message = (error as Error).message.split("\n")[0];
      // The file opens its own BEGIN/COMMIT; a guard failure leaves the
      // session aborted — ROLLBACK so the connection ends cleanly.
      await db.query("ROLLBACK").catch(() => {});
      bad("migration aborted (transaction rolled back — nothing changed)", message);
      await db.end();
      process.exit(1);
    }
  }

  // --- (4) verify ---------------------------------------------------------------
  console.log("");
  const after = await snapshot(db);
  const afterState = stateOf(after.catalog);

  if (afterState === "current") ok("catalog: CHECK + partial unique index now cover the withdrawal actions", after.catalog.checkDef ?? "");
  else bad("catalog still not current", `state=${afterState}`);

  if (after.auditCount === before.auditCount && after.auditPrefixHash === before.auditPrefixHash) {
    ok("admin_audit_logs data untouched", `same ${after.auditCount} row(s); prefix checksum ${after.auditPrefixHash} byte-identical (append-only respected)`);
  } else if (after.auditPrefixHash === before.auditPrefixHash) {
    note("admin_audit_logs grew concurrently", `${before.auditCount} → ${after.auditCount} rows, but every pre-existing row is checksum-identical`);
  } else {
    bad("admin_audit_logs pre-existing rows CHANGED", "a constraint swap must not modify rows — investigate immediately");
  }

  const financeOk = FINANCE_TABLES.every((t) => after.financeCounts[t] >= before.financeCounts[t]);
  if (financeOk) {
    ok(
      "no wallet, withdrawal, ledger or deposit row removed",
      FINANCE_TABLES.map((t) => `${t}:${before.financeCounts[t]}→${after.financeCounts[t]}`).join(" "),
    );
  } else {
    bad("row counts DECREASED on a financial table", FINANCE_TABLES.map((t) => `${t}:${before.financeCounts[t]}→${after.financeCounts[t]}`).join(" "));
  }

  if (after.protectedHash === before.protectedHash) {
    ok(`${PROTECTED_REF} unchanged`, `full-row hash identical (${before.protectedHash})`);
  } else {
    bad(`${PROTECTED_REF} CHANGED — this must not be possible`, "investigate immediately; the migration must not touch deposit_requests");
  }

  // Rolled-back write probe: the EXACT audit rows the action route writes,
  // proving the live constraint+index accept them; nothing is persisted.
  try {
    const users = await db.query("select min(id) as a, min(id) as b from users");
    const uid = (users.rows[0] as { a: number | null }).a;
    if (uid === null) {
      note("write probe skipped", "no users exist yet (FK has no anchor); catalog verification above is the gate");
    } else {
      const probe = `FD-PR38-${randomBytes(6).toString("hex")}`;
      await db.query("BEGIN");
      await db.query(
        `insert into admin_audit_logs (admin_user_id, target_user_id, action, reason, target_ref)
         values ($1, $2, 'reject_withdrawal', 'pr38 migration probe (rolled back)', $3)`,
        [uid, uid, probe],
      );
      await db.query(
        `insert into admin_audit_logs (admin_user_id, target_user_id, action, reason, target_ref)
         values ($1, $2, 'approve_withdrawal', 'pr38 migration probe (rolled back)', $3)`,
        [uid, uid, probe],
      );
      const dup = await db.query("savepoint sp").then(async () => {
        let refused = false;
        try {
          await db.query(
            `insert into admin_audit_logs (admin_user_id, target_user_id, action, reason, target_ref)
             values ($1, $2, 'reject_withdrawal', 'duplicate must be refused', $3)`,
            [uid, uid, probe],
          );
        } catch {
          refused = true;
        }
        await db.query("rollback to savepoint sp");
        return refused;
      });
      await db.query("ROLLBACK");
      const residue = await db.query("select count(*)::int as n from admin_audit_logs where target_ref like 'FD-PR38-%'");
      if (Number(residue.rows[0].n) === 0) ok("write probe: reject+approve audit INSERTs accepted by the live schema");
      else bad("write probe left residue", "the probe transaction must not persist rows");
      if (dup) ok("replay safety: duplicate reject_withdrawal for the same ref refused by the partial unique index");
      else bad("replay safety: duplicate reject_withdrawal was NOT refused");
    }
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    bad("write probe failed", (error as Error).message.split("\n")[0]);
  }

  await db.end().catch(() => {});

  console.log(
    `\nRESULT: ${failures === 0 ? (state === "current" ? "already-current (re-verified)" : "migrated") : "FAILED"} — ${checks - failures}/${checks} checks green`,
  );
  if (failures === 0) {
    console.log(
      "Next: /api/health must report adminAuditSchema.status \"current\"; then the pending\n" +
        "withdrawal can be re-rejected through the normal admin flow (the route restores the\n" +
        "wallet exactly once — no manual refund is ever needed).",
    );
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("\nFATAL:", error);
  process.exit(2);
});
