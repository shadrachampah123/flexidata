/**
 * FlexiData admin email rename CLI.
 *
 * Renaming the address an administrator signs in with is deliberately an
 * OPERATOR action performed against the database, not an HTTP endpoint. The
 * customer-facing profile API (`PATCH /api/account/profile`) can change any
 * signed-in user's own email, but it cannot be used for this job safely: it
 * would rewrite `name` and `phone` too, it never checks `users.is_admin`, and it
 * happily syncs the wallet identity. This script is the whole surface for
 * renaming an admin login.
 *
 * What it touches: `users.email` and `users.updated_at` on ONE row. Nothing
 * else. It cannot create a user, cannot touch `is_admin`, cannot touch a
 * password hash, and cannot reach a wallet, a balance, a ledger row, a deposit,
 * a checkout order or a session: the statement guard below refuses to send any
 * statement that is not either a read or `update "users" …`.
 *
 * Order of operations (each step aborts the run, no partial write):
 *
 *   1. Confirm the schema can express the change (`users.email`, `is_admin`,
 *      `updated_at` all present).
 *   2. Find the account by the OLD address and confirm `users.is_admin = true`.
 *   3. STOP if any account — admin or not — already uses the NEW address.
 *   4. Snapshot the row, its wallets, its sessions, its password resets and a
 *      content digest of every financial table.
 *   5. Print the plan. Without `--yes` this is a dry run and nothing is written.
 *   6. Inside ONE transaction: a single conditional UPDATE, then re-verify the
 *      account, the admin count, the user count and every financial digest.
 *      Any mismatch ROLLS BACK — the database, not this script, is the last
 *      word on "nothing else changed".
 *   7. Re-read after COMMIT and report exactly one admin on the new address.
 *
 * Usage (from the flexiData directory):
 *
 *   npm run admin:email -- --from old@example.com --to new@example.com           # dry run
 *   npm run admin:email -- --from old@example.com --to new@example.com --yes     # perform
 *   npm run admin:email -- --from old@example.com --status                       # inspect one
 *
 * Remember: `users.is_admin` is only ONE of the two signals the admin gate
 * requires. The account's email must ALSO appear in the `ADMIN_EMAILS`
 * environment allowlist, so renaming an admin without updating that variable
 * locks them out of /admin on their very next request. This script checks that
 * for you and says so.
 */
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env.local / .env the way Next.js does (never overriding real env vars),
// so an operator does not have to re-export DATABASE_URL by hand.
for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  try {
    (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile(path);
  } catch {
    // A malformed env file must not mask the real error below.
  }
}

type Row = Record<string, unknown>;
type PgClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;
};

// ---------------------------------------------------------------------------
// Statement guard — the only write this tool can perform is `update "users" …`
// ---------------------------------------------------------------------------

const READ_PREFIX = /^(select|with|show|table|values)\b/i;
const TX_CONTROL_PREFIX = /^(begin|start\s+transaction|commit|rollback|savepoint|release|set|discard)\b/i;
/**
 * The ONE statement shape this tool is allowed to write with: `users`, and only
 * the email + updated_at columns. A generic `update "users" set …` is refused
 * too — `is_admin`, the password hash and everything else are out of reach.
 */
const UPDATE_USERS_RENAME =
  /^update\s+"?users"?\s+set\s+"?email"?\s*=\s*\$\d+\s*,\s*"?updated_at"?\s*=\s*now\(\)(\s+where\b[\s\S]*)?$/i;
const ANY_UPDATE_PREFIX = /^update\b/i;
/** Anything that mutates data or structure, or advances a sequence. */
const WRITE_KEYWORDS =
  /\b(insert|delete|truncate|alter|drop|create|grant|revoke|call|do|copy|refresh|reindex|vacuum|cluster|lock|merge|into|nextval|setval|pg_advisory)\b/i;

/** Raised when this tool is asked to run something outside its remit. */
export class AdminEmailStatementViolation extends Error {
  constructor(statement: string) {
    super(
      `[flexidata:admin-email] refusing to run this statement — the only write allowed here is ` +
        `update "users" set "email" = …, "updated_at" = now(): ${statement.slice(0, 160)}`,
    );
    this.name = "AdminEmailStatementViolation";
  }
}

function normalizeStatement(text: string): string {
  return text
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;+$/, "");
}

/**
 * Guard applied to EVERY statement this tool sends. Exported so the
 * verification harness can assert the behaviour without a database.
 */
export function assertAdminEmailStatement(text: string): void {
  const statement = normalizeStatement(text);
  if (!statement) throw new AdminEmailStatementViolation(text);

  if (ANY_UPDATE_PREFIX.test(statement)) {
    if (!UPDATE_USERS_RENAME.test(statement)) throw new AdminEmailStatementViolation(text);
    if (WRITE_KEYWORDS.test(statement)) throw new AdminEmailStatementViolation(text);
    return;
  }
  if (READ_PREFIX.test(statement) || TX_CONTROL_PREFIX.test(statement)) {
    // `SELECT … INTO` creates a table and `nextval` advances a sequence, so
    // even reads are screened for the write verbs above.
    if (WRITE_KEYWORDS.test(statement)) throw new AdminEmailStatementViolation(text);
    return;
  }
  throw new AdminEmailStatementViolation(text);
}

async function read(client: PgClient, text: string, params: unknown[] = []): Promise<Row[]> {
  assertAdminEmailStatement(text);
  const result = await client.query(text, params);
  return result.rows;
}

async function write(
  client: PgClient,
  text: string,
  params: unknown[] = [],
): Promise<{ rows: Row[]; rowCount: number }> {
  assertAdminEmailStatement(text);
  const result = await client.query(text, params);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

type Args = {
  from: string | null;
  to: string | null;
  apply: boolean;
  status: boolean;
};

/** Same normalization the app itself uses (`src/lib/accounts.ts`). */
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

function parseArgs(argv: string[]): Args {
  const args: Args = { from: null, to: null, apply: false, status: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (raw: string | undefined) => normalizeEmail(raw ?? "");
    if (arg === "--from" || arg === "-f") args.from = value(argv[++i]) || null;
    else if (arg.startsWith("--from=")) args.from = value(arg.slice("--from=".length)) || null;
    else if (arg === "--to" || arg === "-t") args.to = value(argv[++i]) || null;
    else if (arg.startsWith("--to=")) args.to = value(arg.slice("--to=".length)) || null;
    else if (arg === "--yes" || arg === "-y" || arg === "--apply") args.apply = true;
    else if (arg === "--status") args.status = true;
  }

  return args;
}

function usage(): void {
  console.log(
    [
      "",
      "FlexiData admin email rename",
      "",
      "  npm run admin:email -- --from <old> --to <new>          dry run (no write)",
      "  npm run admin:email -- --from <old> --to <new> --yes    perform the rename",
      "  npm run admin:email -- --from <old> --status            inspect one account",
      "",
      "Requires DATABASE_URL (read from the environment or flexiData/.env.local).",
      "Writes exactly one row: users.email + users.updated_at.",
      "Admin access ALSO requires the email to be present in ADMIN_EMAILS.",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// ADMIN_EMAILS — the second signal the admin gate requires
// ---------------------------------------------------------------------------

function allowlist(): Set<string> {
  const raw = (process.env.ADMIN_EMAILS ?? "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Explain the account's effective access, i.e. what the real gate will decide. */
function reportEffectiveAccess(email: string, isAdmin: boolean): void {
  const list = allowlist();
  const listed = list.has(email);

  console.log("");
  console.log(`  users.is_admin        ${isAdmin ? "true" : "false"}`);
  console.log(`  ADMIN_EMAILS listed   ${listed ? "yes" : "no"}`);
  console.log("");

  if (isAdmin && listed) {
    console.log("  => ACCESS GRANTED. This account can reach /admin and /api/admin/*.");
    return;
  }

  console.log("  => NO ACCESS. The gate requires BOTH signals.");
  if (isAdmin && !listed) {
    console.log("");
    if (list.size === 0) {
      console.log("     ADMIN_EMAILS is not set, so nobody can reach the admin area.");
    } else {
      console.log("     The database flag is set, but this email is not in ADMIN_EMAILS.");
    }
    console.log(`     Add it to the deployment environment:  ADMIN_EMAILS=${email}`);
    console.log("     (comma-separate multiple addresses; restart the app afterwards)");
  }
  if (!isAdmin && listed) {
    console.log("");
    console.log("     The email is allowlisted, but the database flag is false.");
    console.log(`     Run:  npm run admin:grant -- --email ${email}`);
  }
}

// ---------------------------------------------------------------------------
// Snapshots used to prove nothing else moved
// ---------------------------------------------------------------------------

/**
 * Tables this tool must never change. `wallets` is listed first because it is
 * both a relationship of the account and the money itself.
 */
export const GUARDED_TABLES = [
  "wallets",
  "transactions",
  "deposit_requests",
  "checkout_orders",
  "scheduled_topups",
  "agent_profiles",
  "bundle_plans",
  "price_alerts",
  "provider_float_balances",
] as const;

type TableDigest = { table: string; rows: number; digest: string };

/**
 * Content digest of one table (md5 over every row, in id order) plus its row
 * count. A table the database does not have yet is reported as absent rather
 * than failing the run — the app itself supports running on a lagging schema.
 */
async function digestTable(client: PgClient, table: string): Promise<TableDigest> {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`Refusing to interpolate table name "${table}".`);
  try {
    const rows = await read(
      client,
      `select coalesce(md5(string_agg(x::text, '|' order by x.id)), '') as digest,
              count(*)::int as row_count
         from "${table}" as x`,
    );
    return {
      table,
      rows: Number(rows[0]?.row_count ?? 0),
      digest: String(rows[0]?.digest ?? ""),
    };
  } catch (error) {
    const code = String((error as { code?: string })?.code ?? "");
    if (code === "42P01") return { table, rows: -1, digest: "absent" };
    throw error;
  }
}

async function digestAll(client: PgClient): Promise<Map<string, TableDigest>> {
  const out = new Map<string, TableDigest>();
  for (const table of GUARDED_TABLES) out.set(table, await digestTable(client, table));
  return out;
}

function digestDiff(before: Map<string, TableDigest>, after: Map<string, TableDigest>): string[] {
  const changed: string[] = [];
  for (const [table, snapshot] of before) {
    const now = after.get(table);
    if (!now || now.digest !== snapshot.digest || now.rows !== snapshot.rows) {
      changed.push(`${table} (rows ${snapshot.rows} -> ${now?.rows ?? "?"})`);
    }
  }
  return changed;
}

/** Column-by-column comparison of the user row, before vs after. */
function rowDiff(before: Row, after: Row): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const a = before[key];
    const b = after[key];
    const norm = (value: unknown) => (value instanceof Date ? value.toISOString() : value ?? null);
    if (norm(a) !== norm(b)) changed.push(`${key}: ${JSON.stringify(norm(a))} -> ${JSON.stringify(norm(b))}`);
  }
  return changed;
}

const asText = (value: unknown): string => (value === null || value === undefined ? "—" : String(value));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.from) {
    usage();
    console.error("A --from address is required.");
    process.exit(1);
  }
  if (args.from && !isLikelyEmail(args.from)) {
    console.error(`"${args.from}" does not look like an email address.`);
    process.exit(1);
  }
  if (!args.status && !args.to) {
    usage();
    console.error("A --to address is required (or use --status to inspect only).");
    process.exit(1);
  }
  if (args.to && !isLikelyEmail(args.to)) {
    console.error(`"${args.to}" does not look like an email address.`);
    process.exit(1);
  }

  if (!process.env.DATABASE_URL?.trim()) {
    console.error(
      "DATABASE_URL is not set. Put it in flexiData/.env.local, or export it before running:\n" +
        "  DATABASE_URL=postgresql://… npm run admin:email -- --from old@example.com --to new@example.com",
    );
    process.exit(1);
  }

  // Imported lazily: `@/db` throws at import time when DATABASE_URL is missing,
  // and the check above produces a much better message.
  const { pool } = await import("@/db");

  const client = (await pool.connect()) as unknown as PgClient & { release: () => void };

  try {
    // -----------------------------------------------------------------------
    // 1. Schema probe — refuse to run against a database that cannot express
    //    admin authorization or the rename itself.
    // -----------------------------------------------------------------------
    const columns = await read(
      client,
      `select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'users'`,
    );
    const present = new Set(columns.map((row) => String(row.column_name)));
    const missing = ["email", "is_admin", "updated_at", "password_hash", "id"].filter(
      (column) => !present.has(column),
    );
    if (missing.length > 0) {
      console.error(
        `This database's "users" table is missing ${missing.join(", ")}, so the rename cannot be verified.\n` +
          "Run `npx drizzle-kit push` against it first.",
      );
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // 2. Find the account on the OLD address.
    // -----------------------------------------------------------------------
    const sourceRows = await read(
      client,
      `select * from "users" where lower("email") = lower($1) order by "id"`,
      [args.from],
    );
    if (sourceRows.length === 0) {
      console.error(
        `No account found with email "${args.from}". Nothing was changed.\n` +
          "List the administrators with:  npm run admin:grant -- --list",
      );
      process.exit(1);
    }
    if (sourceRows.length > 1) {
      console.error(
        `More than one account matches "${args.from}" (${sourceRows.length} rows). ` +
          "Refusing to guess which one to rename. Nothing was changed.",
      );
      process.exit(1);
    }
    const source = sourceRows[0];
    const userId = Number(source.id);
    // The address exactly as stored — the UPDATE below matches on this, so a
    // rename that landed between this read and the write cannot be clobbered.
    const storedEmail = String(source.email);

    const walletRows = await read(
      client,
      `select * from "wallets" where "user_id" = $1 order by "id"`,
      [userId],
    );
    const sessionRows = await read(
      client,
      `select "id", "token_hash", "user_agent", "expires_at" from "sessions"
        where "user_id" = $1 order by "id"`,
      [userId],
    );
    const adminCount = Number(
      (await read(client, `select count(*)::int as c from "users" where "is_admin" = true`))[0]?.c ?? 0,
    );
    const userCount = Number((await read(client, `select count(*)::int as c from "users"`))[0]?.c ?? 0);

    console.log("");
    console.log("Account found");
    console.log(`  id                  #${userId}`);
    console.log(`  email               ${storedEmail}`);
    console.log(`  name                ${asText(source.name)}`);
    console.log(`  phone               ${asText(source.phone)}`);
    console.log(`  referral code       ${asText(source.referral_code)}`);
    console.log(`  created at          ${asText(source.created_at)}`);
    console.log(`  is_admin            ${source.is_admin === true ? "true" : "false"}`);
    console.log(
      `  wallets             ${walletRows.length === 0 ? "none" : walletRows.map((w) => `#${w.id} (${asText(w.number)}, GH₵ ${asText(w.balance)}, ${asText(w.points)} pts)`).join(", ")}`,
    );
    console.log(`  active sessions     ${sessionRows.length}`);

    // -----------------------------------------------------------------------
    // --status stops here: inspect, never write.
    // -----------------------------------------------------------------------
    if (args.status) {
      reportEffectiveAccess(storedEmail.toLowerCase(), source.is_admin === true);
      return;
    }

    // -----------------------------------------------------------------------
    // 3. Requirement: the account being renamed IS the admin one.
    // -----------------------------------------------------------------------
    if (source.is_admin !== true) {
      console.error(
        `\nRefusing: users.is_admin is FALSE for ${storedEmail} (#${userId}).\n` +
          "This tool renames an ADMINISTRATOR's login and stops on any other account,\n" +
          "so a customer's address can never be repointed by mistake. Nothing was changed.\n" +
          "List the administrators with:  npm run admin:grant -- --list",
      );
      process.exit(1);
    }

    const to = args.to as string;
    if (to === storedEmail.toLowerCase()) {
      console.error(
        `\nNo change: ${storedEmail} (#${userId}) already uses "${to}". Nothing was written.`,
      );
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // 4. Requirement: stop if ANY account already uses the new address.
    // -----------------------------------------------------------------------
    const clashRows = await read(
      client,
      `select "id", "email", "is_admin" from "users" where lower("email") = lower($1) order by "id"`,
      [to],
    );
    if (clashRows.length > 0) {
      const clash = clashRows[0];
      console.error(
        `\nRefusing: an account already uses "${to}" — user #${clash.id} ` +
          `(${asText(clash.email)}, is_admin = ${clash.is_admin === true ? "true" : "false"}).\n` +
          "users.email is UNIQUE, so the rename would either fail or collide with that\n" +
          "account. Delete or rename the other account first. Nothing was changed.",
      );
      process.exit(1);
    }

    // -----------------------------------------------------------------------
    // 5. Snapshots.
    // -----------------------------------------------------------------------
    const before = await digestAll(client);
    const resetsBefore = await read(
      client,
      `select "id" from "password_resets" where "user_id" = $1 order by "id"`,
      [userId],
    );

    console.log("");
    console.log("Planned change (one row, two columns)");
    console.log(`  update "users" set "email" = '${to}', "updated_at" = now()`);
    console.log(`   where "id" = ${userId} and "email" = '${storedEmail}' and "is_admin" = true`);
    console.log("");
    console.log("  preserved: id, name, phone, password hash, referral code, is_admin,");
    console.log(`             ${walletRows.length} wallet(s), ${sessionRows.length} session(s), ${resetsBefore.length} password reset(s), created_at`);
    console.log("  untouched: wallets, transactions, deposit_requests, checkout_orders,");
    console.log("             scheduled_topups, agent_profiles (digest-checked before COMMIT)");

    if (!args.apply) {
      console.log("");
      console.log("DRY RUN — nothing was written. Re-run with --yes to apply this change.");
      reportEffectiveAccess(to, true);
      return;
    }

    // -----------------------------------------------------------------------
    // 6. The write — one statement, inside one transaction, verified before
    //    COMMIT so a surprise rolls back instead of landing.
    // -----------------------------------------------------------------------
    await write(client, `begin`);
    try {
      const updated = await write(
        client,
        `update "users"
            set "email" = $1, "updated_at" = now()
          where "id" = $2 and "email" = $3 and "is_admin" = true
          returning "id", "email", "is_admin", "updated_at"`,
        [to, userId, storedEmail],
      );

      if (updated.rowCount !== 1) {
        throw new Error(
          `The conditional UPDATE matched ${updated.rowCount} rows instead of exactly 1, so the ` +
            `account changed between the pre-flight read and the write. Rolled back; nothing was changed.`,
        );
      }
      const written = updated.rows[0];
      if (written.is_admin !== true) {
        throw new Error("The updated row does not have is_admin = true. Rolled back.");
      }

      // Financial data must be byte-identical — checked BEFORE COMMIT.
      const after = await digestAll(client);
      const changed = digestDiff(before, after);
      if (changed.length > 0) {
        throw new Error(
          `Financial tables changed during the rename (${changed.join(", ")}). Rolled back.`,
        );
      }

      // Exactly one account on the new address, none on the old one, and the
      // same number of admins / users as before (i.e. no second user).
      const checks: [string, number, number][] = [
        [
          `accounts on the new address`,
          Number(
            (
              await read(client, `select count(*)::int as c from "users" where lower("email") = lower($1)`, [to])
            )[0]?.c ?? -1,
          ),
          1,
        ],
        [
          `accounts on the old address`,
          Number(
            (
              await read(client, `select count(*)::int as c from "users" where lower("email") = lower($1)`, [
                storedEmail,
              ])
            )[0]?.c ?? -1,
          ),
          0,
        ],
        [
          `accounts with is_admin = true`,
          Number(
            (await read(client, `select count(*)::int as c from "users" where "is_admin" = true`))[0]?.c ?? -1,
          ),
          adminCount,
        ],
        [
          `accounts in total (no second user was created)`,
          Number((await read(client, `select count(*)::int as c from "users"`))[0]?.c ?? -1),
          userCount,
        ],
        [
          `wallets still owned by #${userId}`,
          Number(
            (await read(client, `select count(*)::int as c from "wallets" where "user_id" = $1`, [userId]))[0]
              ?.c ?? -1,
          ),
          walletRows.length,
        ],
        [
          `sessions still owned by #${userId}`,
          Number(
            (await read(client, `select count(*)::int as c from "sessions" where "user_id" = $1`, [userId]))[0]
              ?.c ?? -1,
          ),
          sessionRows.length,
        ],
      ];
      for (const [label, actual, expected] of checks) {
        if (actual !== expected) {
          throw new Error(`Post-write check failed: ${label} = ${actual}, expected ${expected}. Rolled back.`);
        }
      }

      const afterRow = (
        await read(client, `select * from "users" where "id" = $1`, [userId])
      )[0];
      if (String(afterRow.password_hash) !== String(source.password_hash)) {
        throw new Error("The password hash changed during the rename. Rolled back.");
      }
      const unexpected = rowDiff(source, afterRow).filter(
        (entry) => !entry.startsWith("email:") && !entry.startsWith("updated_at:"),
      );
      if (unexpected.length > 0) {
        throw new Error(`Columns other than email/updated_at changed (${unexpected.join("; ")}). Rolled back.`);
      }

      await write(client, `commit`);
    } catch (error) {
      await client.query(`rollback`).catch(() => undefined);
      throw error;
    }

    // -----------------------------------------------------------------------
    // 7. Post-COMMIT verification, read back from the database.
    // -----------------------------------------------------------------------
    const adminsOnNewEmail = await read(
      client,
      `select "id", "email", "name", "is_admin" from "users"
        where lower("email") = lower($1) and "is_admin" = true order by "id"`,
      [to],
    );
    const finalRow = (await read(client, `select * from "users" where "id" = $1`, [userId]))[0];
    const walletsAfter = await read(
      client,
      `select * from "wallets" where "user_id" = $1 order by "id"`,
      [userId],
    );
    const sessionsAfter = await read(
      client,
      `select "id", "token_hash", "user_agent", "expires_at" from "sessions"
        where "user_id" = $1 order by "id"`,
      [userId],
    );
    const resetsAfter = await read(
      client,
      `select "id" from "password_resets" where "user_id" = $1 order by "id"`,
      [userId],
    );
    const finalDigests = await digestAll(client);
    const drifted = digestDiff(before, finalDigests);
    const preserved = rowDiff(source, finalRow).filter(
      (entry) => !entry.startsWith("email:") && !entry.startsWith("updated_at:"),
    );

    console.log("");
    console.log(`RENAMED: ${storedEmail} -> ${asText(finalRow.email)} (user #${userId})`);
    console.log("");
    console.log("  verified after COMMIT");
    console.log(`  admins on "${to}"    ${adminsOnNewEmail.length} (expected 1)`);
    console.log(`  is_admin                 ${finalRow.is_admin === true ? "true (unchanged)" : "FALSE — INVESTIGATE"}`);
    console.log(`  user id                  #${finalRow.id} (unchanged)`);
    console.log(`  password hash            ${preserved.some((e) => e.startsWith("password_hash:")) ? "CHANGED — INVESTIGATE" : "unchanged"}`);
    console.log(`  other columns changed    ${preserved.length === 0 ? "none" : preserved.join(", ")}`);
    console.log(`  wallets                  ${walletsAfter.length} (was ${walletRows.length})`);
    console.log(`  sessions                 ${sessionsAfter.length} (was ${sessionRows.length})`);
    console.log(`  password resets          ${resetsAfter.length} (was ${resetsBefore.length})`);
    console.log(`  financial tables         ${drifted.length === 0 ? "byte-identical" : `CHANGED — INVESTIGATE: ${drifted.join(", ")}`}`);

    const failed =
      adminsOnNewEmail.length !== 1 ||
      finalRow.is_admin !== true ||
      drifted.length > 0 ||
      preserved.length > 0 ||
      Number(finalRow.id) !== userId;
    if (failed) {
      console.error("\nThe rename committed but a verification did not hold. Inspect the account before use.");
      process.exit(1);
    }

    // The gate needs BOTH signals; the allowlist lives in the environment.
    reportEffectiveAccess(to, true);
    const list = allowlist();
    if (storedEmail.toLowerCase() !== to && list.has(storedEmail.toLowerCase())) {
      console.log("");
      console.log(`  NOTE: ADMIN_EMAILS still lists the OLD address (${storedEmail}).`);
      console.log(`        Replace it with ${to} so the renamed account keeps admin access.`);
    }
    console.log("");
    console.log("  Historical rows keep the old address on purpose: checkout_orders.customer_email");
    console.log("  is a point-in-time snapshot of what Paystack was told, and rewriting payment");
    console.log("  records is exactly what this tool refuses to do.");
    console.log("");
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

/**
 * True when this file is the process entry point. The statement guard and the
 * guarded-table list are unit-tested by `scripts/verify-admin-email-change.ts`,
 * which imports this module — an import must never touch a database.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  try {
    return entry === resolve(fileURLToPath(import.meta.url));
  } catch {
    return entry.endsWith(`${sep}change-admin-email.ts`);
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
