/**
 * Admin withdrawal action verification (approve / reject).
 *
 * Why this exists: a production database whose `admin_audit_logs_action_check`
 * still predates the withdrawal actions accepts the entire reject transaction
 * right up to its FINAL statement —
 *
 *   SQLSTATE 23514 check_violation
 *   new row for relation "admin_audit_logs" violates check constraint
 *   "admin_audit_logs_action_check"  (action = 'reject_withdrawal')
 *
 * which rolls back the status change, the wallet refund and the ledger update
 * together, so the admin UI can only say "Failed to process action" while the
 * server log holds the real cause. `drizzle/0007_widen_admin_audit_log_actions.sql`
 * plus `ensureAdminAuditActions()` (runtime self-heal) fix it.
 *
 * This script answers two questions against a REAL database / app:
 *
 *   Phase A (always, DATABASE_URL)   — read-only catalog probe: does the schema
 *                                      accept both withdrawal audit actions?
 *   Phase B (also needs BASE_URL)     — full end-to-end drive of the REAL API:
 *                                      reject, refund accounting, replay
 *                                      safety, authorization and validation.
 *
 * Safety rules (identical to `verify-withdrawal-schema.ts`):
 *   * it never runs against a URL that looks like a production host unless
 *     explicitly overridden via ALLOW_PRODUCTION=1 (refuse by default);
 *   * every row it creates is tagged with a unique `fd-awa-` prefix and is
 *     deleted again before exit (admin audit rows first — they RESTRICT);
 *   * the genuine live Paystack deposit `DP-MTMZN2P8SSBR` is snapshotted
 *     before and after, and the script fails loudly if it changed;
 *   * no SQL error text is ever printed to the client — everything here is
 *     server-side diagnostics.
 *
 * Usage from the flexiData directory:
 *   DATABASE_URL='postgresql://…' npx tsx scripts/verify-admin-withdrawal-action.ts
 *   DATABASE_URL='postgresql://…' BASE_URL='http://127.0.0.1:3000' npx tsx scripts/verify-admin-withdrawal-action.ts
 *
 * The server at BASE_URL must trust one admin email via ADMIN_EMAILS; the
 * script uses `fd-awa-admin@verify.flexidata.internal` and grants
 * `users.is_admin` for that account itself (test database only). Wallet
 * funding uses whichever provider the server has configured (mock settles
 * instantly; Paystack TEST would need the hosted checkout, so the script
 * reports the provider it exercised).
 */
import { Pool } from "pg";

const PROTECTED_REF = "DP-MTMZN2P8SSBR";
const ADMIN_EMAIL = "fd-awa-admin@verify.flexidata.internal";
const PREFIX = "fd-awa-";
const PASSWORD = "Passw0rd!long-verify";

const REPLAY_ACTIONS = ["delivery_resolved", "refund_review", "approve_withdrawal", "reject_withdrawal"];

let failures = 0;
let checks = 0;
const ok = (label: string, detail = ""): void => {
  checks += 1;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
};
const bad = (label: string, detail = ""): void => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
};
const note = (label: string, detail = ""): void => console.log(`  ·    ${label}${detail ? ` — ${detail}` : ""}`);

/** Minimal cookie jar so the drive uses the app's real session handling. */
class Jar {
  private cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async req(base: string, path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(base + path, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: this.header(), ...(init.headers ?? {}) },
      redirect: "manual",
    });
    this.absorb(res);
    return res;
  }
}

function assertEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set. Export it before running this script (it is never printed).`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = assertEnv("DATABASE_URL");
  const baseUrl = process.env.BASE_URL?.trim() ?? "";
  if (
    baseUrl &&
    !/^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(baseUrl) &&
    process.env.ALLOW_PRODUCTION !== "1"
  ) {
    console.error(
      `BASE_URL (${baseUrl}) does not look like a local test server (127.0.0.1 / localhost).\n` +
        "This script creates and deletes database rows; pass ALLOW_PRODUCTION=1 to force it.",
    );
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  // Snapshot the genuine Paystack deposit before anything else happens.
  const protectedBefore = await pool.query(
    "select ref, status, amount, wallet_id, paystack_transaction_id from deposit_requests where ref = $1",
    [PROTECTED_REF],
  );

  try {
    console.log("\nPhase A — catalog probe (read-only)\n");
    await phaseA(pool);

    if (baseUrl) {
      console.log("\nPhase B — end-to-end API drive\n");
      await phaseB(pool, baseUrl);
    } else {
      note("Phase B skipped", "set BASE_URL to drive the real API end to end");
    }
  } finally {
    const protectedAfter = await pool
      .query("select ref, status, amount, wallet_id, paystack_transaction_id from deposit_requests where ref = $1", [
        PROTECTED_REF,
      ])
      .catch(() => null);
    if (protectedAfter && JSON.stringify(protectedBefore.rows) === JSON.stringify(protectedAfter.rows)) {
      ok(`genuine deposit ${PROTECTED_REF} untouched`, protectedBefore.rows.length ? "row unchanged" : "not present");
    } else if (protectedAfter) {
      bad(`genuine deposit ${PROTECTED_REF} untouched`);
    }
    await pool.end();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Phase A — catalog
// ---------------------------------------------------------------------------

async function phaseA(pool: Pool): Promise<void> {
  const table = await pool.query("select to_regclass('admin_audit_logs') is not null as present");
  if (!table.rows[0].present) {
    bad("admin_audit_logs exists");
    return;
  }

  const wd = await pool.query(
    "select to_regclass('withdrawal_requests') is not null as present, " +
      "(select array_agg(e.enumlabel) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'withdrawal_status') as statuses",
  );
  if (wd.rows[0].present) {
    ok("withdrawal_requests table present");
    const statuses: string[] = wd.rows[0].statuses ?? [];
    const need = ["pending", "rejected", "processing"];
    const missingStatus = need.filter((s) => !statuses.includes(s));
    if (missingStatus.length === 0) ok("withdrawal_status enum has pending/rejected/processing");
    else bad("withdrawal_status enum has pending/rejected/processing", `missing ${missingStatus.join(",")}`);
  } else {
    bad("withdrawal_requests table present");
  }

  const check = await pool.query(
    "select pg_get_constraintdef(c.oid) as def from pg_constraint c " +
      "where c.conrelid = 'admin_audit_logs'::regclass and c.conname = 'admin_audit_logs_action_check' and c.contype = 'c'",
  );
  const checkDef: string | null = check.rows[0]?.def ?? null;
  if (checkDef === null) {
    bad("admin_audit_logs_action_check present");
  } else {
    const missing = REPLAY_ACTIONS.filter((a) => !checkDef.includes(a));
    if (missing.length === 0) ok("action CHECK accepts the withdrawal actions", "approve_withdrawal + reject_withdrawal");
    else bad("action CHECK accepts the withdrawal actions", `narrow 0003-era constraint, missing ${missing.join(",")}`);
  }

  const idx = await pool.query("select indexdef as def from pg_indexes where indexname = 'admin_audit_logs_order_action_idx'");
  const idxDef: string | null = idx.rows[0]?.def ?? null;
  if (idxDef === null) {
    bad("replay-safe partial unique index present");
  } else {
    const missing = REPLAY_ACTIONS.filter((a) => !idxDef.includes(a));
    if (missing.length === 0) ok("partial unique index covers withdrawal actions", "one audit row per (ref, action)");
    else note("partial unique index predates withdrawal actions", `missing ${missing.join(",")} (widened by 0007)`);
  }

  const cols = await pool.query(
    "select column_name from information_schema.columns where table_name = 'withdrawal_requests'",
  );
  const have = new Set<string>(cols.rows.map((r: { column_name: string }) => r.column_name));
  const need = ["id", "ref", "user_id", "wallet_id", "amount", "fee", "net_amount", "status", "admin_user_id", "admin_rejection_reason"];
  const missingCols = need.filter((c) => !have.has(c));
  if (missingCols.length === 0) ok("required withdrawal_requests columns present");
  else bad("required withdrawal_requests columns present", `missing ${missingCols.join(",")}`);

  const tx = await pool.query(
    "select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'tx_type'",
  );
  if (tx.rows.some((r: { enumlabel: string }) => r.enumlabel === "withdrawal")) ok("tx_type includes 'withdrawal'");
  else bad("tx_type includes 'withdrawal'");
}

// ---------------------------------------------------------------------------
// Phase B — end-to-end
// ---------------------------------------------------------------------------

async function phaseB(pool: Pool, base: string): Promise<void> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const userEmail = `${PREFIX}${stamp}-user@verify.flexidata.internal`;
  const userPhone = `024${(1_000_000 + (parseInt(stamp.slice(-6), 36) % 8_999_999)).toString()}`;
  const userJar = new Jar();
  const adminJar = new Jar();

  // 1. Accounts + sessions (throwaway; deleted in cleanup()).
  await userJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Awa Verify User", email: userEmail, phone: userPhone, password: PASSWORD }),
  });
  const userLogin = await userJar
    .req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: userEmail, password: PASSWORD }) })
    .then((r) => r.status);
  if (userLogin === 200) ok("test user registered + signed in");
  else {
    bad("test user registered + signed in", `login status ${userLogin}`);
    return;
  }

  await adminJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Awa Verify Admin", email: ADMIN_EMAIL, phone: "0209776688", password: PASSWORD }),
  });
  await adminJar.req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: ADMIN_EMAIL, password: PASSWORD }) });
  await pool.query("update users set is_admin = true where email = $1", [ADMIN_EMAIL]);

  const adminMe = await adminJar.req(base, "/api/admin/me");
  if (adminMe.status === 200) ok("admin gate admits the allowlisted admin");
  else {
    bad("admin gate admits the allowlisted admin", `status ${adminMe.status} — is ADMIN_EMAILS set to include ${ADMIN_EMAIL}?`);
    return;
  }

  const walletRow = (
    await pool.query("select w.id, w.balance from wallets w join users u on u.id = w.user_id where u.email = $1", [userEmail])
  ).rows[0];
  if (!walletRow) {
    bad("test wallet exists");
    return;
  }
  const walletId: number = walletRow.id;

  // 2. Deposit funds the wallet (12. deposits still work — mock provider settles
  //    instantly in the dev/test runtime).
  const fund = await userJar.req(base, "/api/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 10, method: "momo_mtn" }) });
  const fundBody = (await fund.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (fund.status === 200 && fundBody.ok) ok("wallet deposit works", "funded GH₵10");
  else bad("wallet deposit works", fundBody.error ?? `status ${fund.status}`);

  let balance = 0;
  for (let i = 0; i < 20; i++) {
    balance = Number((await pool.query("select balance from wallets where id = $1", [walletId])).rows[0].balance);
    if (balance >= 10) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (balance === 10) ok("deposit credited the wallet", "balance 10.00");
  else bad("deposit credited the wallet", `balance ${balance}`);

  const withdraw = async (amount: number): Promise<{ ok: boolean; ref?: string; error?: string }> => {
    const res = await userJar.req(base, "/api/wallet/withdraw", {
      method: "POST",
      // NOTE (payout-readiness F1): withdrawal methods are strictly whitelisted
      // (`momo_mtn` / `telecel_cash`) — the legacy free-form `"momo"` value is
      // rejected by the API, so this driver uses a whitelisted method. The test
      // phone is 024… (MTN), matching `momo_mtn`.
      body: JSON.stringify({ amount, method: "momo_mtn", dest: userPhone }),
    });
    return (await res.json().catch(() => ({ ok: false, error: `status ${res.status}` }))) as { ok: boolean; ref?: string; error?: string };
  };
  const balanceNow = async (): Promise<number> =>
    Number((await pool.query("select balance from wallets where id = $1", [walletId])).rows[0].balance);

  // 3. User withdrawal request still works (11.).
  const wd1 = await withdraw(5);
  if (wd1.ok && wd1.ref) ok("user withdrawal request works", `ref ${wd1.ref}`);
  else {
    bad("user withdrawal request works", wd1.error);
    return;
  }
  const afterRequest = await balanceNow();
  // 5. Accounting: the request deducts the GROSS amount (5.00, not the 4.90 net).
  if (Math.abs(10 - afterRequest - 5) < 0.001) ok("request deducted the GROSS amount", "10.00 → 5.00 (fee 0.10, net 4.90)");
  else bad("request deducted the GROSS amount", `balance ${afterRequest}`);

  const wdRow = (await pool.query("select id, ref, amount, fee, net_amount, status from withdrawal_requests where ref = $1", [wd1.ref])).rows[0];

  // 4. Non-admin cannot reject (7.): the gate answers the identical 404 so the
  //    admin area stays undiscoverable — never 200, never 500.
  const nonAdmin = await userJar.req(base, `/api/admin/withdrawals/${wdRow.id}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "should not matter" }),
  });
  if (nonAdmin.status === 404) ok("non-admin is refused (404, no oracle)");
  else bad("non-admin is refused (404, no oracle)", `status ${nonAdmin.status}`);

  // 5. Invalid ids (8.).
  const junkId = await adminJar.req(base, "/api/admin/withdrawals/not-a-number/action", {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "x" }),
  });
  if (junkId.status === 400) ok("non-numeric id refused with 400");
  else bad("non-numeric id refused with 400", `status ${junkId.status}`);

  const missingId = await adminJar.req(base, "/api/admin/withdrawals/99999999/action", {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "x" }),
  });
  const missingBody = (await missingId.json().catch(() => ({}))) as { error?: string };
  if (missingId.status === 404 && /not found/i.test(missingBody.error ?? "")) ok("unknown id refused with 404");
  else bad("unknown id refused with 404", `status ${missingId.status}`);

  // 6. Validation of the reason (9.): the admin UI refuses to send an empty
  //    reason, so the API must too — and a >240 char reason must be a 400, not
  //    a rolled-back money transaction.
  const noReason = await adminJar.req(base, `/api/admin/withdrawals/${wdRow.id}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "" }),
  });
  if (noReason.status === 400) ok("missing rejection reason refused with 400");
  else bad("missing rejection reason refused with 400", `status ${noReason.status}`);

  const longReason = await adminJar.req(base, `/api/admin/withdrawals/${wdRow.id}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "x".repeat(241) }),
  });
  if (longReason.status === 400) ok("over-length reason refused with 400", "max 240 chars");
  else bad("over-length reason refused with 400", `status ${longReason.status}`);

  if ((await balanceNow()) === afterRequest) ok("failed pre-checks moved no money");
  else bad("failed pre-checks moved no money", `balance ${await balanceNow()}`);

  // 7. THE ACTION: pending → reject (1.).
  const reject = await adminJar.req(base, `/api/admin/withdrawals/${wdRow.id}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "Wrong destination number" }),
  });
  const rejectBody = (await reject.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (reject.status === 200 && rejectBody.ok) ok("pending withdrawal rejected", "HTTP 200 {ok:true}");
  else {
    bad("pending withdrawal rejected", `status ${reject.status} ${JSON.stringify(rejectBody)}`);
    return;
  }

  // 8. Status + accounting + audit + ledger after the reject.
  const post = (
    await pool.query(
      "select w.status, w.admin_rejection_reason, (select balance from wallets where id = $2) as balance, " +
      "(select count(*) from admin_audit_logs where target_ref = w.ref and action = 'reject_withdrawal') as audit_rows, " +
      "(select status from transactions where ref = w.ref) as ledger_status " +
      "from withdrawal_requests w where w.id = $1",
      [wdRow.id, walletId],
    )
  ).rows[0];

  if (post.status === "rejected") ok("withdrawal_requests.status = rejected (3.)");
  else bad("withdrawal_requests.status = rejected (3.)", post.status);

  // 2. Refunded exactly once, exactly the deducted GROSS amount.
  const refund = afterRequest + Number(post.balance) - 10;
  if (Math.abs(refund - 5) < 0.001 && Number(post.balance) === 10) ok("wallet refunded the GROSS amount exactly once", "5.00 → 10.00");
  else bad("wallet refunded the GROSS amount exactly once", `refunded ${refund.toFixed(2)}, balance ${post.balance}`);

  if (Number(post.audit_rows) === 1) ok("exactly one reject_withdrawal audit row (4.)");
  else bad("exactly one reject_withdrawal audit row (4.)", `${post.audit_rows} rows`);

  if (post.ledger_status === "failed") ok("ledger row marked failed with the reason");
  else bad("ledger row marked failed with the reason", post.ledger_status);

  if (/Wrong destination number/.test(post.admin_rejection_reason ?? "")) ok("rejection reason stored on the request");
  else bad("rejection reason stored on the request", post.admin_rejection_reason);

  // 9. Repeated reject cannot refund twice (5.).
  const replay = await adminJar.req(base, `/api/admin/withdrawals/${wdRow.id}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "again" }),
  });
  const replayBalance = await balanceNow();
  if (replay.status === 409 && replayBalance === 10) ok("replayed reject refused with 409, no second refund");
  else bad("replayed reject refused with 409, no second refund", `status ${replay.status} balance ${replayBalance}`);

  // 10. Approve still works (10.) + rejecting an approved withdrawal is
  //     refused (6.).
  const wd2 = await withdraw(5);
  if (!wd2.ok) {
    bad("second withdrawal for the approve path", wd2.error);
  } else {
    const wd2Row = (await pool.query("select id from withdrawal_requests where ref = $1", [wd2.ref])).rows[0];
    const approve = await adminJar.req(base, `/api/admin/withdrawals/${wd2Row.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    const approveBody = (await approve.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (approve.status === 200 && approveBody.ok) ok("admin approve still works", `${wd2.ref} → processing`);
    else bad("admin approve still works", `status ${approve.status} ${JSON.stringify(approveBody)}`);

    const approveState = (
      await pool.query(
        "select status, (select count(*) from admin_audit_logs where target_ref = $1 and action = 'approve_withdrawal') as audit_rows, " +
        "(select status from transactions where ref = $1) as ledger_status from withdrawal_requests where id = $2",
        [wd2.ref, wd2Row.id],
      )
    ).rows[0];
    // NOTE (payout-readiness F5): approval authorizes a payout (`processing`) but
    // never completes one — the ledger row deliberately STAYS `pending` (no
    // money has moved). `successful` is reserved for a future provider webhook.
    if (approveState.status === "processing" && Number(approveState.audit_rows) === 1 && approveState.ledger_status === "pending") {
      ok("approved withdrawal is processing with audit + ledger (ledger stays pending, not successful)");
    } else {
      bad("approved withdrawal is processing with audit + ledger (ledger stays pending, not successful)", JSON.stringify(approveState));
    }

    const rejectApproved = await adminJar.req(base, `/api/admin/withdrawals/${wd2Row.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "reject", reason: "too late" }),
    });
    if (rejectApproved.status === 409) ok("rejecting an already-processed withdrawal refused with 409");
    else bad("rejecting an already-processed withdrawal refused with 409", `status ${rejectApproved.status}`);
  }

  await cleanup(pool, userEmail);
}

/** Deletes ONLY rows this script created (audit first: they RESTRICT user deletes). */
async function cleanup(pool: Pool, userEmail: string): Promise<void> {
  try {
    await pool.query(
      "delete from admin_audit_logs where target_ref in (select ref from withdrawal_requests where user_id in " +
        "(select id from users where email like $1)) or admin_user_id in (select id from users where email = $2)",
      [`${PREFIX}%`, ADMIN_EMAIL],
    );
    const deleted = await pool.query("delete from users where email like $1 or email = $2 returning id", [
      `${PREFIX}%`,
      ADMIN_EMAIL,
    ]);
    note("cleanup", `${deleted.rows.length} throwaway account(s) removed (wallets, ledger rows and withdrawals cascade)`);
  } catch (error) {
    note("cleanup failed", (error as Error).message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
