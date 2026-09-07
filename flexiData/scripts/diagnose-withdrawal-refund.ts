/**
 * Withdrawal rejection / refund — read-only production forensics.
 *
 * Answers the incident questions against a REAL database WITHOUT CHANGING
 * anything (the whole investigation runs inside `SET TRANSACTION READ ONLY`):
 *
 *   * which withdrawal failed (id, ref, user, wallet, amount, status);
 *   * wallet balance before / at / after the rejection (where derivable);
 *   * the refund/reversal ledger entry (type, status, direction, amount, ref);
 *   * the admin audit trail rows and timestamps;
 *   * a verdict for each case from the incident matrix:
 *       A  the rejection never committed (rolled back)
 *       B  wallet not restored
 *       C  refund ledger missing / never flipped
 *       D  API serves a stale balance (server-side check only)
 *       E/F UI/Router-cache staleness (server-side: balance IS in the DB)
 *       G  race / double refund
 *       H  success returned before commit
 *       I  other (schema drift — the audit catalog is probed read-only)
 *
 * The genuine live Paystack deposit `DP-MTMZN2P8SSBR` is snapshotted (FULL
 * row) before and after and the run fails loudly if it changed — although a
 * read-only transaction cannot modify it, the comparison is there so the
 * report carries the proof.
 *
 * Usage from the flexiData directory:
 *   DATABASE_URL='postgresql://…' npx tsx scripts/diagnose-withdrawal-refund.ts
 *   DATABASE_URL='postgresql://…' npx tsx scripts/diagnose-withdrawal-refund.ts --ref WDL-XXXX
 *   DATABASE_URL='postgresql://…' npx tsx scripts/diagnose-withdrawal-refund.ts --id 42
 *   DATABASE_URL='postgresql://…' npx tsx scripts/diagnose-withdrawal-refund.ts --since 2026-09-07T12:00:00Z
 *   … --json   machine-readable output
 *
 * No filter → the 10 most recent withdrawal requests are examined.
 */
import { Pool } from "pg";

const PROTECTED_REF = "DP-MTMZN2P8SSBR";

function parseArgs(argv: string[]): { id: string | null; ref: string | null; since: string | null; json: boolean } {
  const out = { id: null as string | null, ref: null as string | null, since: null as string | null, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--id") out.id = argv[++i] ?? null;
    else if (a.startsWith("--id=")) out.id = a.slice(5);
    else if (a === "--ref") out.ref = argv[++i] ?? null;
    else if (a.startsWith("--ref=")) out.ref = a.slice(6);
    else if (a === "--since") out.since = argv[++i] ?? null;
    else if (a.startsWith("--since=")) out.since = a.slice(8);
    else if (a === "--json") out.json = true;
  }
  return out;
}

interface WdRow {
  id: number;
  ref: string;
  user_id: number;
  wallet_id: number;
  amount: string;
  fee: string;
  net_amount: string;
  status: string;
  admin_user_id: number | null;
  admin_rejection_reason: string | null;
  destination_details: { account?: string };
  created_at: string;
  updated_at: string;
  user_email: string | null;
  user_name: string | null;
  wallet_number: string | null;
  wallet_balance: string | null;
  ledger_rows: Array<{
    id: number;
    type: string;
    status: string;
    direction: string;
    amount: string;
    provider_message: string | null;
    created_at: string;
  }>;
  audit_rows: Array<{
    id: number;
    admin_user_id: number;
    action: string;
    reason: string | null;
    created_at: string;
  }>;
  derived_balance: string;
  delta: string;
}

async function snapshotProtected(client: import("pg").PoolClient): Promise<unknown> {
  const res = await client.query("select * from deposit_requests where ref = $1 order by id", [PROTECTED_REF]);
  return JSON.stringify(res.rows);
}

function verdict(w: WdRow, auditSchema: { status: string }): string {
  const wdLedger = w.ledger_rows.filter((l) => l.type === "withdrawal" && l.direction === "out");
  const refundLedger = wdLedger.find((l) => l.status === "failed");
  const pendingLedger = wdLedger.find((l) => l.status === "pending");
  const rejects = w.audit_rows.filter((a) => a.action === "reject_withdrawal");

  if (w.status === "pending") {
    return [
      "CASE A (likely): the rejection NEVER committed — the request is still `pending`,",
      "  so the wallet was never restored. If an admin clicked Reject and saw",
      "  `schema_maintenance_required` (503) this is the blocked-schema path (case I: the",
      "  audit catalog predates drizzle/0007 and the operator has not applied it).",
      "  If the admin saw a generic 500 instead, check the server log for",
      "  `admin withdrawal action failed … cause=23514` (legacy audit CHECK) or",
      "  `cause=42P01` (missing table).",
    ].join("\n");
  }
  if (w.status === "rejected") {
    if (rejects.length > 1) {
      return "CASE G (VIOLATION): more than one reject_withdrawal audit row — a double refund may exist; reconcile the wallet immediately.";
    }
    if (!refundLedger) {
      return [
        "CASE B/C (VIOLATION): the request says `rejected` but its ledger row was never flipped",
        `  (ledger rows: ${wdLedger.length ? wdLedger.map((l) => `${l.status}`).join(",") : "NONE"}). The atomic reject should`,
        "  have flipped it in the same transaction — investigate server logs and the",
        "  wallet balance derivation below.",
      ].join("\n");
    }
    if (rejects.length === 0) {
      return "NOTE: rejected with a failed ledger row but NO reject_withdrawal audit row (typical for pre-PR-#37 rejections; not a money fault by itself).";
    }
    const consistent = Number(w.delta) === 0;
    return [
      "CONSISTENT: request rejected, ledger flipped to `failed` exactly once, one audit row.",
      consistent
        ? "  Wallet balance matches the ledger-derived figure — the refund is in the database (cases D/E/F are UI/cache, not accounting)."
        : `  WARNING: stored balance ${w.wallet_balance} differs from ledger-derived ${w.derived_balance} (delta ${w.delta}) — reconcile before trusting either.`,
    ].join("\n");
  }
  if (w.status === "processing" || w.status === "successful") {
    return "INFORMATIONAL: the request was approved (no refund is expected).";
  }
  if (pendingLedger && w.status === "failed") {
    return "CASE B: request marked `failed` while its ledger is still `pending` — no refund was applied.";
  }
  return `INFORMATIONAL: status=${w.status} — no refund expected.`;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Export it before running this script (it is never printed).");
    process.exit(2);
  }
  const args = parseArgs(process.argv);
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  const protectedBefore = await snapshotProtected(client);
  let protectedAfter: unknown = null;
  let failures = 0;
  try {
    // The ENTIRE investigation is read-only at the transaction level: any
    // accidental write is impossible, not just discouraged.
    await client.query("begin");
    await client.query("set transaction read only");

    // Audit catalog probe (the case-I discriminator: legacy CHECK/index).
    const auditTable = await client.query("select to_regclass('admin_audit_logs') is not null as present");
    const checkDef = await client.query(
      "select pg_get_constraintdef(c.oid) as def from pg_constraint c " +
        "where c.conrelid = 'admin_audit_logs'::regclass and c.conname = 'admin_audit_logs_action_check' and c.contype = 'c'",
    );
    const idxDef = await client.query("select indexdef as def from pg_indexes where indexname = 'admin_audit_logs_order_action_idx'");
    const check: string | null = checkDef.rows[0]?.def ?? null;
    const idx: string | null = idxDef.rows[0]?.def ?? null;
    const need = ["approve_withdrawal", "reject_withdrawal"];
    const auditSchema = {
      status:
        !auditTable.rows[0].present ||
        check === null ||
        idx === null ||
        need.some((a) => !check.includes(a)) ||
        need.some((a) => !idx.includes(a))
          ? "legacy"
          : "current",
    };

    const where: string[] = [];
    const params: unknown[] = [];
    if (args.id) {
      params.push(Number(args.id));
      where.push(`w.id = $${params.length}`);
    }
    if (args.ref) {
      params.push(args.ref);
      where.push(`w.ref = $${params.length}`);
    }
    if (args.since) {
      params.push(args.since);
      where.push(`w.created_at >= $${params.length}::timestamptz`);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";

    const res = await client.query(
      `select w.id, w.ref, w.user_id, w.wallet_id, w.amount, w.fee, w.net_amount,
              w.status, w.admin_user_id, w.admin_rejection_reason, w.destination_details,
              w.created_at, w.updated_at,
              u.email as user_email, u.name as user_name,
              wt.number as wallet_number, wt.balance as wallet_balance
         from withdrawal_requests w
         left join users u on u.id = w.user_id
         left join wallets wt on wt.id = w.wallet_id
         ${whereSql}
      order by w.created_at desc
      limit 20`,
      params,
    );

    const rows: WdRow[] = [];
    for (const w of res.rows) {
      const ledger = await client.query(
        "select id, type, status, direction, amount, provider_message, created_at " +
          "from transactions where ref = $1 order by id",
        [w.ref],
      );
      const audit = await client.query(
        "select id, admin_user_id, action, reason, created_at " +
          "from admin_audit_logs where target_ref = $1 order by id",
        [w.ref],
      );
      // Ledger-derived balance: every `in` ledger row that succeeded, minus
      // every `out` row that succeeded (a `failed`/`pending` out row already
      // had its money restored, or never left — so it counts as zero).
      const derived = await client.query(
        `select coalesce(sum(
                 case when direction = 'in' and status = 'successful' then amount
                      when direction = 'out' and status = 'successful' then -amount
                      else 0 end
               ), 0) as derived
           from transactions where wallet_id = $1`,
        [w.wallet_id],
      );
      const derivedBalance: string = derived.rows[0].derived;
      rows.push({
        ...w,
        ledger_rows: ledger.rows,
        audit_rows: audit.rows,
        derived_balance: derivedBalance,
        delta: (
          await client.query(`select ($1::numeric - $2::numeric) as d`, [w.wallet_balance ?? "0", derivedBalance])
        ).rows[0].d,
      });
    }

    await client.query("rollback"); // read-only — nothing was ever written

    if (args.json) {
      console.log(
        JSON.stringify({ protectedRef: PROTECTED_REF, auditSchema, withdrawals: rows }, null, 2),
      );
    } else {
      console.log("\nWithdrawal rejection / refund — read-only diagnostic\n");
      console.log(
        `Audit schema: ${auditSchema.status === "current" ? "current" : "LEGACY (drizzle/0007 not applied — every admin approve/reject rolls back or is refused with 503 schema_maintenance_required)"}`,
      );
      if (rows.length === 0) {
        console.log("No withdrawal requests matched the filter.");
      }
      for (const w of rows) {
        console.log(`\n──────────────────────────────────────────────────────────────`);
        console.log(`withdrawal ${w.id}  ${w.ref}  status=${w.status}`);
        console.log(
          `  user: ${w.user_id} (${w.user_email ?? "?"} / ${w.user_name ?? "?"})   wallet: ${w.wallet_id} (${w.wallet_number ?? "?"})`,
        );
        console.log(`  amount ${w.amount}  fee ${w.fee}  net ${w.net_amount}  to ${w.destination_details?.account ?? "?"}`);
        console.log(`  created ${w.created_at}  updated ${w.updated_at}`);
        if (w.admin_user_id) console.log(`  acted by admin ${w.admin_user_id}  reason: ${w.admin_rejection_reason ?? "—"}`);
        console.log(`  wallet balance NOW: ${w.wallet_balance}   ledger-derived: ${w.derived_balance}   delta: ${w.delta}`);
        if (w.ledger_rows.length) {
          for (const l of w.ledger_rows) {
            console.log(
              `  ledger ${l.id}: type=${l.type} status=${l.status} direction=${l.direction} amount=${l.amount}${l.provider_message ? ` note="${l.provider_message}"` : ""} (${l.created_at})`,
            );
          }
        } else {
          console.log("  ledger: NO rows for this ref");
        }
        if (w.audit_rows.length) {
          for (const a of w.audit_rows) {
            console.log(`  audit ${a.id}: admin=${a.admin_user_id} action=${a.action} reason=${a.reason ?? "—"} (${a.created_at})`);
          }
        } else {
          console.log("  audit: no rows for this ref");
        }
        console.log(`  VERDICT:`);
        for (const line of verdict(w, auditSchema).split("\n")) console.log(`  ${line}`);
      }
    }
  } finally {
    await client.query("rollback").catch(() => {});
    protectedAfter = await snapshotProtected(client).catch(() => null);
    client.release();
    await pool.end();
  }

  if (protectedAfter === protectedBefore) {
    console.log(`\nProtected deposit ${PROTECTED_REF}: unchanged (full-row snapshot identical).`);
  } else {
    failures += 1;
    console.error(`\nPROTECTED DEPOSIT ${PROTECTED_REF} CHANGED — this must not be possible in a read-only run; investigate immediately.`);
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
