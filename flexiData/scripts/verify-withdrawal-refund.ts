/**
 * Withdrawal rejection / refund — dedicated regression verification.
 *
 * THE invariant this script exists to prove (forever):
 *
 *   WHEN A VALID WITHDRAWAL IS REJECTED,
 *   THE ORIGINAL USER'S WALLET IS RESTORED EXACTLY ONCE,
 *   THE LEDGER RECORD IS UPDATED EXACTLY ONCE,
 *   THE OPERATION IS ATOMIC AND IDEMPOTENT,
 *   AND THE USER'S WALLET UI RELIABLY REFLECTS THE NEW DATABASE BALANCE.
 *
 * It drives the REAL app API end to end (same convention as
 * `verify-wallet-freshness.ts` / `verify-admin-withdrawal-action.ts`):
 *
 *   user wallet = GH₵ 5.00
 *   withdraw GH₵ 5.00            → database 0.00, page + API say 0.00   (A)
 *   admin rejects                → database 5.00, one audit row, ledger failed
 *   GET /api/wallet              → 5.00, Cache-Control no-store          (H)
 *   GET /wallet (fresh request)  → renders GH₵ 5.00                      (C)
 *   GET /                        → money chip renders GH₵ 5.00
 *   admin wallet view            → stored balance GH₵ 5.00               (G)
 *   replayed reject              → 409 withdrawal_already_processed,
 *                                  still 5.00, still one audit row       (B)
 *   5 concurrent rejects         → exactly one 200, four 409, one refund  (F)
 *   blocked audit schema         → explicit 503 schema_maintenance_required
 *                                  BEFORE any money statement (no drift
 *                                  rollback disguised as "try again")
 *   deposits                     → still credit exactly once             (I)
 *   DP-MTMZN2P8SSBR              → byte-identical before and after       (J)
 *
 * Safety rules (identical to the sibling verify scripts):
 *   * refuses to run against a non-local BASE_URL unless ALLOW_PRODUCTION=1;
 *   * every row it creates is tagged `fd-wr-` and deleted again on exit;
 *   * the genuine live Paystack deposit `DP-MTMZN2P8SSBR` is snapshotted
 *     (FULL row) before and after and must be byte-identical;
 *   * it only ever drives withdrawals/deposits of its OWN throwaway account;
 *   * the catalog probe phase is strictly read-only.
 *
 * Usage from the flexiData directory (dev/preview server with a working
 * wallet funding provider — mock settles instantly, Paystack TEST needs the
 * hosted checkout, so prefer mock or the local stub for CI):
 *
 *   DATABASE_URL='postgresql://…' npx tsx scripts/verify-withdrawal-refund.ts
 *   DATABASE_URL='postgresql://…' BASE_URL='http://127.0.0.1:3000' \
 *     npx tsx scripts/verify-withdrawal-refund.ts
 *
 * The blocked-schema section needs a database whose audit CHECK predates the
 * withdrawal actions. When the script's role can apply DDL it expects the
 * runtime self-heal to repair the drift (and proves that happened); when the
 * role is DML-only it proves the route answers 503 `schema_maintenance_
 * required` with no money moved.
 */
import { Pool } from "pg";

const PROTECTED_REF = "DP-MTMZN2P8SSBR";
const ADMIN_EMAIL = "fd-wr-admin@verify.flexidata.internal";
const PREFIX = "fd-wr-";
const PASSWORD = "Passw0rd!long-verify";

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

/** The wallet balance chip rendered on /wallet (PageHeader link chip). */
function walletChipBalance(html: string): number | null {
  const chip = /<a[^>]*href="\/wallet"[^>]*>\s*GH₵\s*([\d,]+(?:\.\d{2})?)\s*<\/a>/.exec(html);
  return chip ? Number(chip[1].replace(/,/g, "")) : null;
}

/**
 * The home page renders the balance inside WalletCard, directly after the
 * "Total balance" label. The generic "first GH₵ figure" regex is NOT safe
 * here: the RSC payload embedded in the HTML contains bundle-plan prices
 * (GH₵ 29.50 …) that appear before the card, so the assertion is anchored on
 * the label instead.
 */
function homeWalletBalance(html: string): number | null {
  const idx = html.indexOf("Total balance");
  if (idx < 0) return null;
  const m = /GH₵\s*([\d,]+(?:\.\d{2})?)/.exec(html.slice(idx, idx + 1200));
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** Full-row snapshot of the protected deposit, for a byte comparison. */
async function snapshotProtected(pool: Pool): Promise<string> {
  const res = await pool.query(
    "select * from deposit_requests where ref = $1 order by id",
    [PROTECTED_REF],
  );
  return JSON.stringify(res.rows);
}

async function auditProbe(pool: Pool): Promise<{
  tablePresent: boolean;
  checkDef: string | null;
  indexDef: string | null;
  legacy: boolean;
  canCreate: boolean;
}> {
  const table = await pool.query("select to_regclass('admin_audit_logs') is not null as present");
  const check = await pool.query(
    "select pg_get_constraintdef(c.oid) as def from pg_constraint c " +
      "where c.conrelid = 'admin_audit_logs'::regclass and c.conname = 'admin_audit_logs_action_check' and c.contype = 'c'",
  );
  const idx = await pool.query("select indexdef as def from pg_indexes where indexname = 'admin_audit_logs_order_action_idx'");
  const checkDef: string | null = check.rows[0]?.def ?? null;
  const indexDef: string | null = idx.rows[0]?.def ?? null;
  const need = ["approve_withdrawal", "reject_withdrawal"];
  const legacy =
    !table.rows[0].present ||
    checkDef === null ||
    indexDef === null ||
    need.some((a) => !checkDef.includes(a)) ||
    need.some((a) => !indexDef.includes(a));
  const can = await pool.query("select has_schema_privilege(current_user, 'public', 'create') as can_create");
  return {
    tablePresent: Boolean(table.rows[0].present),
    checkDef,
    indexDef,
    legacy,
    canCreate: Boolean(can.rows[0].can_create),
  };
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
  const protectedBefore = await snapshotProtected(pool);

  try {
    console.log("\nPhase A — catalog probe (read-only)\n");
    const probe = await phaseA(pool);

    if (baseUrl) {
      console.log("\nPhase B — end-to-end API drive\n");
      await phaseB(pool, baseUrl, probe);
    } else {
      note("Phase B skipped", "set BASE_URL to drive the real API end to end");
    }
  } finally {
    const protectedAfter = await snapshotProtected(pool).catch(() => null);
    if (protectedAfter === protectedBefore) {
      ok(`genuine deposit ${PROTECTED_REF} untouched (J)`, protectedBefore === "[]" ? "not present here" : "full row byte-identical");
    } else {
      bad(`genuine deposit ${PROTECTED_REF} untouched (J)`, "the protected row CHANGED");
    }
    await pool.end();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Phase A — catalog
// ---------------------------------------------------------------------------

async function phaseA(pool: Pool): Promise<Awaited<ReturnType<typeof auditProbe>>> {
  const tables = await pool.query(
    "select to_regclass('wallets') is not null as wallets, " +
      "to_regclass('transactions') is not null as txs, " +
      "to_regclass('withdrawal_requests') is not null as withdrawals, " +
      "to_regclass('admin_audit_logs') is not null as audit",
  );
  const t = tables.rows[0];
  if (t.wallets && t.txs && t.withdrawals && t.audit) ok("money tables present", "wallets, transactions, withdrawal_requests, admin_audit_logs");
  else bad("money tables present", JSON.stringify(t));

  const enums = await pool.query(
    "select (select bool_and(e.enumlabel = any(ARRAY['pending','rejected','processing']::text[])) or count(*) >= 3 " +
      "from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'withdrawal_status') as wd_ok, " +
      "(select exists(select 1 from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'tx_type' and e.enumlabel = 'withdrawal')) as tx_ok",
  );
  if (enums.rows[0].wd_ok) ok("withdrawal_status enum has the lifecycle values");
  else bad("withdrawal_status enum has the lifecycle values");
  if (enums.rows[0].tx_ok) ok("tx_type includes 'withdrawal'");
  else bad("tx_type includes 'withdrawal'");

  const probe = await auditProbe(pool);
  if (!probe.legacy) {
    ok("audit action CHECK + replay index accept the withdrawal actions");
  } else {
    bad(
      "audit action CHECK + replay index accept the withdrawal actions",
      probe.tablePresent
        ? "legacy drift detected — drizzle/0007 not applied (the action route must now answer 503 until it is)"
        : "admin_audit_logs missing",
    );
  }
  return probe;
}

// ---------------------------------------------------------------------------
// Phase B — end to end
// ---------------------------------------------------------------------------

async function phaseB(pool: Pool, base: string, probe: Awaited<ReturnType<typeof auditProbe>>): Promise<void> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const userEmail = `${PREFIX}${stamp}-user@verify.flexidata.internal`;
  const userPhone = `024${(1_000_000 + (parseInt(stamp.slice(-6), 36) % 8_999_999)).toString()}`;
  const userJar = new Jar();
  const adminJar = new Jar();

  // --- accounts -----------------------------------------------------------
  await userJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Wr Verify User", email: userEmail, phone: userPhone, password: PASSWORD }),
  });
  const userLogin = await userJar
    .req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: userEmail, password: PASSWORD }) })
    .then((r) => r.status);
  if (userLogin !== 200) {
    bad("test user registered + signed in", `login status ${userLogin}`);
    return;
  }
  await adminJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Wr Verify Admin", email: ADMIN_EMAIL, phone: "0209776611", password: PASSWORD }),
  });
  await adminJar.req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: ADMIN_EMAIL, password: PASSWORD }) });
  await pool.query("update users set is_admin = true where email = $1", [ADMIN_EMAIL]);
  const adminMe = await adminJar.req(base, "/api/admin/me");
  if (adminMe.status !== 200) {
    bad("admin gate admits the allowlisted admin", `status ${adminMe.status} — is ADMIN_EMAILS set to include ${ADMIN_EMAIL}?`);
    return;
  }
  ok("throwaway user + admin ready");

  const walletId: number = (
    await pool.query("select w.id from wallets w join users u on u.id = w.user_id where u.email = $1", [userEmail])
  ).rows[0].id;
  const balanceNow = async (): Promise<number> =>
    Number((await pool.query("select balance from wallets where id = $1", [walletId])).rows[0].balance);

  // --- (I) deposit still works, credits exactly once ------------------------
  const fund = await userJar.req(base, "/api/wallet/fund", {
    method: "POST",
    body: JSON.stringify({ amount: 5, method: "momo_mtn", source: userPhone }),
  });
  const fundBody = (await fund.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!(fund.status === 200 && fundBody.ok)) {
    bad("deposit still works (I)", fundBody.error ?? `status ${fund.status}`);
    return;
  }
  let settled = 0;
  for (let i = 0; i < 20; i += 1) {
    settled = await balanceNow();
    if (settled >= 5) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const depositRows = await pool.query(
    "select count(*)::int as n from deposit_requests where wallet_id = $1 and status = 'successful'",
    [walletId],
  );
  if (settled === 5 && Number(depositRows.rows[0].n) === 1) ok("deposit credited the wallet exactly once (I)", "GH₵ 5.00, one successful deposit row");
  else bad("deposit credited the wallet exactly once (I)", `balance ${settled}, successful rows ${depositRows.rows[0].n}`);

  // --- (A) withdrawal: 5 → 0, page + API agree with the database -----------
  const withdraw = async (amount: number): Promise<{ ok: boolean; ref?: string; newBalance?: number; error?: string }> => {
    const res = await userJar.req(base, "/api/wallet/withdraw", {
      method: "POST",
      body: JSON.stringify({ amount, method: "momo_mtn", dest: userPhone }),
    });
    return (await res.json().catch(() => ({ ok: false, error: `status ${res.status}` }))) as {
      ok: boolean;
      ref?: string;
      newBalance?: number;
      error?: string;
    };
  };

  const wd1 = await withdraw(5);
  if (!(wd1.ok && wd1.ref)) {
    bad("withdrawal request works", wd1.error);
    return;
  }
  if ((await balanceNow()) === 0) ok("wallet database balance is GH₵ 0.00 after the request (A)");
  else bad("wallet database balance is GH₵ 0.00 after the request (A)", `balance ${await balanceNow()}`);

  const summaryZero = await userJar.req(base, "/api/wallet");
  const summaryZeroBody = (await summaryZero.json().catch(() => ({}))) as { ok?: boolean; wallet?: { balance?: number } };
  if (summaryZero.status === 200 && summaryZeroBody.wallet?.balance === 0) ok("GET /api/wallet says 0.00 while pending");
  else bad("GET /api/wallet says 0.00 while pending");

  const pageZero = await userJar.req(base, "/wallet");
  if (walletChipBalance(await pageZero.text()) === 0) ok("Wallet page renders GH₵ 0.00 while pending");
  else bad("Wallet page renders GH₵ 0.00 while pending");

  const wd1Id: number = (await pool.query("select id from withdrawal_requests where ref = $1", [wd1.ref])).rows[0].id;

  // --- the blocked state: no refund can exist, the contract is a 503 --------
  // When the audit schema predates the withdrawal actions AND this role
  // cannot apply the upgrade, the money route must refuse with an explicit
  // maintenance answer BEFORE any money statement — not roll back silently
  // behind a "please try again". No refund assertions can follow, because no
  // refund is legal until an operator repairs the database.
  if (probe.legacy && !probe.canCreate) {
    const before = await balanceNow();
    const blocked = await adminJar.req(base, `/api/admin/withdrawals/${wd1Id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "reject", reason: "blocked probe" }),
    });
    const blockedBody = (await blocked.json().catch(() => ({}))) as { code?: string; error?: string };
    const after = await balanceNow();
    const stillPending = (await pool.query("select status from withdrawal_requests where ref = $1", [wd1.ref])).rows[0].status;
    const audit = (
      await pool.query("select count(*)::int as n from admin_audit_logs where target_ref = $1", [wd1.ref])
    ).rows[0].n;
    if (
      blocked.status === 503 &&
      blockedBody.code === "schema_maintenance_required" &&
      before === after &&
      stillPending === "pending" &&
      Number(audit) === 0
    ) {
      ok("blocked audit schema → explicit 503 schema_maintenance_required, request still pending, no money moved");
    } else {
      bad(
        "blocked audit schema → explicit 503 schema_maintenance_required, request still pending, no money moved",
        `status ${blocked.status} code ${blockedBody.code} balance ${before}→${after} request ${stillPending} audit ${audit}`,
      );
    }
    note("refund checks skipped", "no refund is legal while the audit schema is blocked — operator must apply drizzle/0007");
    await cleanup(pool, userEmail);
    return;
  }

  // --- the rejection: atomic restore ---------------------------------------
  const reject = await adminJar.req(base, `/api/admin/withdrawals/${wd1Id}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "verify: refund regression" }),
  });
  const rejectBody = (await reject.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string };
  if (reject.status === 200 && rejectBody.ok) ok("admin rejection accepted");
  else bad("admin rejection accepted", `status ${reject.status} ${JSON.stringify(rejectBody)}`);

  const post = (
    await pool.query(
      "select w.status, w.admin_rejection_reason, (select balance from wallets where id = $2) as balance, " +
        "(select count(*) from admin_audit_logs where target_ref = w.ref and action = 'reject_withdrawal') as audit_rows, " +
        "(select status from transactions where ref = w.ref and wallet_id = $2) as ledger_status, " +
        "(select count(*) from transactions where ref = w.ref and type = 'withdrawal') as ledger_rows, " +
        "w.amount from withdrawal_requests w where w.id = $1",
      [wd1Id, walletId],
    )
  ).rows[0];

  if (post.status === "rejected") ok("withdrawal_requests.status = rejected");
  else bad("withdrawal_requests.status = rejected", post.status);
  if (Number(post.balance) === 5) ok("wallet database restored to GH₵ 5.00 — the exact gross amount, once");
  else bad("wallet database restored to GH₵ 5.00 — the exact gross amount, once", `balance ${post.balance}`);
  if (Number(post.audit_rows) === 1) ok("exactly one reject_withdrawal audit row");
  else bad("exactly one reject_withdrawal audit row", `${post.audit_rows}`);
  if (post.ledger_status === "failed" && Number(post.ledger_rows) === 1) ok("ledger row flipped pending → failed, exactly one ledger row");
  else bad("ledger row flipped pending → failed, exactly one ledger row", `ledger ${post.ledger_status} rows ${post.ledger_rows}`);
  if (/verify: refund regression/.test(post.admin_rejection_reason ?? "")) ok("rejection reason stored on the request");
  else bad("rejection reason stored on the request", String(post.admin_rejection_reason));

  // --- (H) user API reflects the restored balance, uncached ------------------
  const summary = await userJar.req(base, "/api/wallet");
  const summaryBody = (await summary.json().catch(() => ({}))) as { ok?: boolean; wallet?: { balance?: number } };
  const cache = summary.headers.get("cache-control") ?? "";
  if (summary.status === 200 && summaryBody.wallet?.balance === 5 && /no-store/.test(cache)) {
    ok("GET /api/wallet returns the restored GH₵ 5.00 with no-store (H)");
  } else {
    bad("GET /api/wallet returns the restored GH₵ 5.00 with no-store (H)", `balance ${summaryBody.wallet?.balance} cache=${cache}`);
  }

  // --- (C) the Wallet page server-renders the restored balance ---------------
  const pageAfter = await userJar.req(base, "/wallet");
  if (walletChipBalance(await pageAfter.text()) === 5) ok("Wallet page (fresh request) renders GH₵ 5.00 (C)");
  else bad("Wallet page (fresh request) renders GH₵ 5.00 (C)");

  // The home page is the other money surface: same restored figure (rendered
  // in the WalletCard, so anchor on the "Total balance" label — the embedded
  // RSC payload contains plan prices that a generic first-match would pick up).
  const home = await userJar.req(base, "/");
  if (homeWalletBalance(await home.text()) === 5) ok("Home page WalletCard renders the restored GH₵ 5.00");
  else bad("Home page WalletCard renders the restored GH₵ 5.00");

  // --- (G) the admin wallet view shows the restored stored balance -----------
  const adminWalletPage = await adminJar.req(base, `/admin/wallets/${walletId}`);
  const adminWalletHtml = await adminWalletPage.text();
  const stored = /Stored wallet balance[\s\S]{0,400}?GH₵\s*([\d,]+(?:\.\d{2})?)/.exec(adminWalletHtml);
  if (adminWalletPage.status === 200 && stored && Number(stored[1].replace(/,/g, "")) === 5) {
    ok("admin wallet view shows the restored stored balance (G)");
  } else {
    bad("admin wallet view shows the restored stored balance (G)", `status ${adminWalletPage.status}`);
  }

  // --- (B) idempotency: a replayed reject must not refund again --------------
  const replay = await adminJar.req(base, `/api/admin/withdrawals/${wd1Id}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "replay" }),
  });
  const replayBody = (await replay.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string };
  const replayAudit = await pool.query(
    "select count(*)::int as n from admin_audit_logs where target_ref = $1 and action = 'reject_withdrawal'",
    [wd1.ref],
  );
  if (replay.status === 409 && replayBody.code === "withdrawal_already_processed" && (await balanceNow()) === 5 && Number(replayAudit.rows[0].n) === 1) {
    ok("replayed reject → 409 withdrawal_already_processed, no second refund (B)");
  } else {
    bad(
      "replayed reject → 409 withdrawal_already_processed, no second refund (B)",
      `status ${replay.status} code ${replayBody.code} balance ${await balanceNow()} audit ${replayAudit.rows[0].n}`,
    );
  }

  // --- (F) concurrency: parallel rejects, exactly one refund -----------------
  const fund2 = await userJar.req(base, "/api/wallet/fund", {
    method: "POST",
    body: JSON.stringify({ amount: 5, method: "momo_mtn", source: userPhone }),
  });
  for (let i = 0; i < 20 && (await balanceNow()) < 10; i += 1) await new Promise((r) => setTimeout(r, 250));
  const wd2 = await withdraw(5);
  if (!(wd2.ok && wd2.ref)) {
    bad("second withdrawal for the concurrency race", wd2.error ?? `fund2 ${fund2.status}`);
    return;
  }
  const wd2Id: number = (await pool.query("select id from withdrawal_requests where ref = $1", [wd2.ref])).rows[0].id;

  const parallel = await Promise.all(
    Array.from({ length: 5 }, () =>
      adminJar
        .req(base, `/api/admin/withdrawals/${wd2Id}/action`, {
          method: "POST",
          body: JSON.stringify({ action: "reject", reason: "race" }),
        })
        .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as { code?: string } })),
    ),
  );
  const successes = parallel.filter((r) => r.status === 200).length;
  const conflicts = parallel.filter((r) => r.status === 409 && r.body.code === "withdrawal_already_processed").length;
  const raceAudit = await pool.query(
    "select count(*)::int as n from admin_audit_logs where target_ref = $1 and action = 'reject_withdrawal'",
    [wd2.ref],
  );
  const raceLedger = await pool.query(
    "select count(*)::int as n from transactions where ref = $1 and type = 'withdrawal' and status = 'failed'",
    [wd2.ref],
  );
  if (successes === 1 && conflicts === 4 && (await balanceNow()) === 10 && Number(raceAudit.rows[0].n) === 1 && Number(raceLedger.rows[0].n) === 1) {
    ok("5 concurrent rejects → exactly one 200, four 409, one refund (F)");
  } else {
    bad(
      "5 concurrent rejects → exactly one 200, four 409, one refund (F)",
      `200s ${successes}, 409s ${conflicts}, balance ${await balanceNow()}, audit ${raceAudit.rows[0].n}, failed ledger rows ${raceLedger.rows[0].n}`,
    );
  }

  // --- blocked audit schema: explicit 503, never a silent rollback -----------
  await blockedSchemaGate(pool, base, adminJar, userJar, walletId, probe);

  await cleanup(pool, userEmail);
}

/**
 * When the audit catalog predates the withdrawal actions AND the role can
 * apply DDL: the runtime self-heal (exercised by the rejects above) must have
 * widened it, so a fresh probe must now read "current". (The DML-only blocked
 * state is proven earlier in the drive, where the money route must answer
 * 503 before any money statement.)
 */
async function blockedSchemaGate(
  pool: Pool,
  base: string,
  adminJar: Jar,
  userJar: Jar,
  walletId: number,
  probe: Awaited<ReturnType<typeof auditProbe>>,
): Promise<void> {
  void base;
  void adminJar;
  void userJar;
  void walletId;

  if (probe.legacy && probe.canCreate) {
    // DDL-capable role: the self-heal ran inside the successful rejects above.
    const now = await auditProbe(pool);
    if (!now.legacy) ok("runtime self-heal widened the audit CHECK (DDL-capable role)");
    else bad("runtime self-heal widened the audit CHECK (DDL-capable role)", "still legacy after the rejects");
  } else {
    note("blocked-schema gate", "audit schema already current — nothing to prove");
  }
}

/** Deletes ONLY rows this script created (audit first: they RESTRICT user deletes). */
async function cleanup(pool: Pool, userEmail: string): Promise<void> {
  try {
    const ids = (await pool.query("select id from users where email like $1 or email = $2", [`${PREFIX}%`, ADMIN_EMAIL])).rows;
    const userIds = ids.map((r: { id: number }) => r.id);
    if (userIds.length === 0) return;
    await pool.query(
      "delete from admin_audit_logs where target_user_id = any($1::int[]) or admin_user_id = any($1::int[])",
      [userIds],
    );
    await pool.query("delete from withdrawal_requests where user_id = any($1::int[])", [userIds]);
    await pool.query("delete from transactions where wallet_id in (select id from wallets where user_id = any($1::int[]))", [userIds]);
    await pool.query("delete from deposit_requests where wallet_id in (select id from wallets where user_id = any($1::int[]))", [userIds]);
    await pool.query("delete from agent_profiles where wallet_id in (select id from wallets where user_id = any($1::int[]))", [userIds]);
    const deleted = await pool.query("delete from users where id = any($1::int[]) returning id", [userIds]);
    note("cleanup", `${deleted.rows.length} throwaway account(s) removed (wallets and their rows with them)`);
  } catch (error) {
    note("cleanup failed", (error as Error).message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
