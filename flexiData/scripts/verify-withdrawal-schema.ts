/**
 * Withdrawal schema verification.
 *
 * Why this exists: `withdrawal_requests` shipped in `src/db/schema.ts` while the
 * SQL file its migration journal entry points at
 * (`drizzle/0005_lively_hiroim.sql`) was never committed. A deployed database
 * therefore had no table, and `POST /api/wallet/withdraw` answered 500 with
 * `relation "withdrawal_requests" does not exist` (SQLSTATE 42P01) while
 * `/api/health` still read "current" for every schema it did check.
 *
 * This script answers one question against a real database: **can that endpoint
 * write?** It never sends money and never persists anything.
 *
 *   Phase A (always)  — read-only catalog probe inside a READ ONLY transaction.
 *   Phase B (--write-probe) — the exact INSERTs the withdrawal route performs,
 *                       against throwaway rows, inside a transaction that is
 *                       ROLLED BACK. It proves the columns, the
 *                       `withdrawal_status` / `tx_type` enum values and both
 *                       foreign keys accept the write, then asserts nothing was
 *                       left behind.
 *
 * Existing rows are never updated or deleted. The genuine live Paystack deposit
 * is named explicitly and is re-checked before and after, so a run that touches
 * it fails loudly instead of quietly.
 *
 * Usage from the flexiData directory:
 *   DATABASE_URL='postgresql://…' npx tsx scripts/verify-withdrawal-schema.ts
 *   DATABASE_URL='postgresql://…' npx tsx scripts/verify-withdrawal-schema.ts --write-probe
 */
import { Pool } from "pg";

const PROTECTED_REF = "DP-MTMZN2P8SSBR";

const REQUIRED_COLUMNS = [
  "id",
  "ref",
  "user_id",
  "wallet_id",
  "amount",
  "fee",
  "net_amount",
  "destination_method",
  "destination_details",
  "status",
  "admin_user_id",
  "admin_rejection_reason",
  "provider_fields",
  "created_at",
  "updated_at",
];

const REQUIRED_STATUS_VALUES = ["pending", "processing", "successful", "failed", "rejected", "cancelled"];

const REQUIRED_INDEXES = [
  "withdrawal_requests_pkey",
  "withdrawal_requests_ref_unique",
  "withdrawal_requests_user_idx",
  "withdrawal_requests_wallet_idx",
  "withdrawal_requests_status_idx",
  "withdrawal_requests_created_at_idx",
];

const REQUIRED_FKS = [
  { name: "withdrawal_requests_user_id_users_id_fk", table: "users" },
  { name: "withdrawal_requests_wallet_id_wallets_id_fk", table: "wallets" },
];

let failures = 0;
const ok = (label: string, detail = "") => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label: string, detail = "") => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Export it before running this script (it is never printed).");
    process.exit(2);
  }
  const writeProbe = process.argv.includes("--write-probe");

  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10_000 });
  const client = await pool.connect();

  const protectedBefore = await client.query(
    `select t.ref, t.status, t.amount from transactions t where t.ref = $1`,
    [PROTECTED_REF],
  );

  try {
    // ------------------------------------------------------------------ Phase A
    console.log("\nPhase A — withdrawal schema (read-only catalog probe)");
    await client.query("begin");
    await client.query("set transaction read only");

    const table = await client.query(
      `select count(*)::int as n from information_schema.tables
        where table_schema = current_schema() and table_name = 'withdrawal_requests'`,
    );
    const hasTable = table.rows[0].n > 0;
    hasTable
      ? ok("withdrawal_requests exists")
      : bad("withdrawal_requests exists", "missing — withdrawals will 500. Apply drizzle/0005_lively_hiroim.sql or run `npx drizzle-kit push`.");

    if (hasTable) {
      const cols = await client.query(
        `select column_name from information_schema.columns
          where table_schema = current_schema() and table_name = 'withdrawal_requests'`,
      );
      const present = new Set(cols.rows.map((r: { column_name: string }) => r.column_name));
      const missing = REQUIRED_COLUMNS.filter((c) => !present.has(c));
      missing.length === 0
        ? ok("all 15 columns present")
        : bad("all 15 columns present", `missing: ${missing.join(", ")}`);

      const idx = await client.query(
        `select indexname from pg_indexes
          where schemaname = current_schema() and tablename = 'withdrawal_requests'`,
      );
      const haveIdx = new Set(idx.rows.map((r: { indexname: string }) => r.indexname));
      const missingIdx = REQUIRED_INDEXES.filter((i) => !haveIdx.has(i));
      missingIdx.length === 0
        ? ok("primary key, unique ref and 4 indexes present")
        : bad("primary key, unique ref and 4 indexes present", `missing: ${missingIdx.join(", ")}`);

      const fks = await client.query(
        `select con.conname, ref.relname as target
           from pg_constraint con
           join pg_class rel on rel.oid = con.conrelid
           join pg_class ref on ref.oid = con.confrelid
          where con.contype = 'f' and rel.relname = 'withdrawal_requests'`,
      );
      const haveFk = new Map(fks.rows.map((r: { conname: string; target: string }) => [r.conname, r.target]));
      for (const fk of REQUIRED_FKS) {
        haveFk.get(fk.name) === fk.table
          ? ok(`foreign key ${fk.name} -> ${fk.table}`)
          : bad(`foreign key ${fk.name} -> ${fk.table}`, haveFk.has(fk.name) ? `points at ${haveFk.get(fk.name)}` : "missing");
      }
    }

    const statusEnum = await client.query(
      `select coalesce(array_agg(e.enumlabel order by e.enumsortorder), '{}'::text[]) as labels
         from pg_type ty join pg_enum e on e.enumtypid = ty.oid
        where ty.typname = 'withdrawal_status'`,
    );
    const statusValues: string[] = statusEnum.rows[0].labels ?? [];
    const missingStatus = REQUIRED_STATUS_VALUES.filter((v) => !statusValues.includes(v));
    missingStatus.length === 0
      ? ok("withdrawal_status enum holds all 6 lifecycle values")
      : bad("withdrawal_status enum holds all 6 lifecycle values", `missing: ${missingStatus.join(", ")}`);

    const txTypes = await client.query(
      `select coalesce(array_agg(e.enumlabel order by e.enumsortorder), '{}'::text[]) as labels
         from pg_type ty join pg_enum e on e.enumtypid = ty.oid
        where ty.typname = 'tx_type'`,
    );
    const typeValues: string[] = txTypes.rows[0].labels ?? [];
    typeValues.includes("withdrawal")
      ? ok("tx_type accepts 'withdrawal'")
      : bad("tx_type accepts 'withdrawal'", "the ledger insert would fail with SQLSTATE 22P02");

    await client.query("rollback");

    // ------------------------------------------------------------------ Phase B
    if (writeProbe) {
      console.log("\nPhase B — withdrawal write probe (INSERTs, then ROLLBACK)");
      // A dedicated connection: the probe deliberately provokes errors on a
      // lagging database, and a session that has seen one must not be reused
      // for the checks that follow.
      const probe = await pool.connect();
      const stamp = Date.now();
      const userEmail = `withdrawal-probe-${stamp}@probe.invalid`;
      const walletNumber = `00${String(stamp).slice(-8)}`;
      const probeRef = `WDL-PROBE${String(stamp).slice(-5)}`;

      await probe.query("begin");
      try {
        const user = await probe.query(
          `insert into users (name, email, phone, password_hash, referral_code)
           values ('Withdrawal probe', $1, $2, 'scrypt:probe:probe', $3) returning id`,
          [userEmail, walletNumber, `PRB${String(stamp).slice(-5)}`],
        );
        const userId = user.rows[0].id;
        const wallet = await probe.query(
          `insert into wallets (user_id, name, number, balance) values ($1, 'Withdrawal probe', $2, '5.00') returning id`,
          [userId, walletNumber],
        );
        const walletId = wallet.rows[0].id;

        // The three statements the route runs inside its money transaction.
        await probe.query(`update wallets set balance = balance - 5.00 where id = $1`, [walletId]);
        const request = await probe.query(
          `insert into withdrawal_requests
             (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status)
           values ($1, $2, $3, '5.00', '0.10', '4.90', 'momo_mtn', '{"account":"0244123456"}'::jsonb, 'pending')
           returning id, status`,
          [probeRef, userId, walletId],
        );
        await probe.query(
          `insert into transactions (ref, wallet_id, type, status, direction, title, subtitle, amount)
           values ($1, $2, 'withdrawal', 'pending', 'out', 'Withdrawal Request', 'To momo_mtn', '5.00')`,
          [probeRef, walletId],
        );
        ok(
          "route's three writes succeed against this schema",
          `withdrawal_requests.id=${request.rows[0].id} status=${request.rows[0].status}`,
        );

        // The admin approve/reject transitions the ledger and the request use.
        await probe.query(`update withdrawal_requests set status = 'processing' where id = $1`, [request.rows[0].id]);
        await probe.query(`update withdrawal_requests set status = 'rejected' where id = $1`, [request.rows[0].id]);
        ok("withdrawal_status transitions (pending -> processing -> rejected) accepted");
      } catch (error) {
        bad("write probe", (error as Error).message);
      }
      // Nothing may survive this script. The rollback runs unconditionally —
      // including after a failed write, and before any further query — so a
      // probe that threw halfway cannot leave a row behind.
      await probe.query("rollback");
      probe.release();

      if (!hasTable) {
        ok("rollback left nothing behind", "no withdrawal_requests table exists to have written to");
      } else {
        const leftovers = await client.query(
          `select
             (select count(*)::int from users where email = $1) as users,
             (select count(*)::int from wallets where number = $2) as wallets,
             (select count(*)::int from withdrawal_requests where ref = $3) as requests,
             (select count(*)::int from transactions where ref = $3) as ledger`,
          [userEmail, walletNumber, probeRef],
        );
        const l = leftovers.rows[0];
        l.users === 0 && l.wallets === 0 && l.requests === 0 && l.ledger === 0
          ? ok("rollback left nothing behind")
          : bad("rollback left nothing behind", JSON.stringify(l));
      }
    } else {
      console.log("\nPhase B skipped — pass --write-probe to prove the schema accepts the route's writes (still rolled back).");
    }

    // ------------------------------------------------------------- protection
    console.log("\nProtected data");
    const protectedAfter = await client.query(
      `select t.ref, t.status, t.amount from transactions t where t.ref = $1`,
      [PROTECTED_REF],
    );
    const same = JSON.stringify(protectedBefore.rows) === JSON.stringify(protectedAfter.rows);
    same
      ? ok(`${PROTECTED_REF} unchanged`, protectedAfter.rows[0] ? JSON.stringify(protectedAfter.rows[0]) : "not present in this database")
      : bad(`${PROTECTED_REF} unchanged`, `before=${JSON.stringify(protectedBefore.rows)} after=${JSON.stringify(protectedAfter.rows)}`);
  } finally {
    client.release();
    await pool.end();
  }

  console.log(failures === 0 ? "\nRESULT: withdrawal path is writable ✅" : `\nRESULT: ${failures} check(s) failed ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("verify-withdrawal-schema crashed:", error);
  process.exit(2);
});
