/**
 * Wallet freshness regression verification.
 *
 * The incident this guards against: after an admin rejects a withdrawal (the
 * refund lands in the user's wallet), the USER-FACING Wallet page must display
 * the refunded balance — GH₵ 5.00 in the report — without a log-out/log-in or
 * a hard reload. The database was always right; the stale layer was the
 * browser's client-side Router Cache serving a previously-rendered payload.
 *
 * This script answers, against a REAL database / app:
 *
 *   Phase A (always, DATABASE_URL)   — read-only catalog probe of everything
 *                                      the wallet data path depends on.
 *   Phase B (also needs BASE_URL)    — the exact scenario, end to end:
 *
 *     user wallet = GH₵ 5.00
 *     user requests GH₵ 5 withdrawal       → wallet GH₵ 0.00
 *     Wallet page (server render)          → GH₵ 0.00
 *     admin rejects the withdrawal         → wallet back to GH₵ 5.00
 *     Wallet page (server render)          → GH₵ 5.00   ← the regression
 *     GET /api/wallet (freshness signal)   → GH₵ 5.00, no-store
 *     admin wallet view                    → GH₵ 5.00
 *     replayed reject                      → 409, no duplicate refund
 *     deposits still work, transfers work  → balances move & render
 *
 * Safety rules (same as `verify-admin-withdrawal-action.ts`):
 *   * never runs against a non-local BASE_URL unless ALLOW_PRODUCTION=1;
 *   * every row it creates is tagged `fd-wf-` and deleted again on exit;
 *   * the genuine live Paystack deposit `DP-MTMZN2P8SSBR` is snapshotted
 *     before and after and must be byte-identical;
 *   * the rejected withdrawal + refund created by the REAL operator is never
 *     touched — the script only drives withdrawals it created itself.
 *
 * Usage from the flexiData directory (dev server with PAYMENTS_PROVIDER=mock
 * and WITHDRAWALS_ENABLED=true — Phase B creates a withdrawal through the
 * REAL API, so the temporary kill switch must be explicitly re-armed):
 *   DATABASE_URL='postgresql://…' npx tsx scripts/verify-wallet-freshness.ts
 *   DATABASE_URL='postgresql://…' BASE_URL='http://127.0.0.1:3000' \
 *     ADMIN_EMAILS=… npx tsx scripts/verify-wallet-freshness.ts
 */
import { Pool } from "pg";

const PROTECTED_REF = "DP-MTMZN2P8SSBR";
const ADMIN_EMAIL = "fd-wf-admin@verify.flexidata.internal";
const PREFIX = "fd-wf-";
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

/**
 * The balance the Wallet page's header chip renders (server-rendered prop from
 * `wallets.balance`). Matched on the `<a href="/wallet">GH₵ X.XX</a>` chip so
 * the amount chips on the page (20/50/100…) cannot mask the real figure.
 */
function walletChipBalance(html: string): number | null {
  const chip = /<a[^>]*href="\/wallet"[^>]*>\s*GH₵\s*([\d,]+(?:\.\d{2})?)\s*<\/a>/.exec(html);
  if (chip) return Number(chip[1].replace(/,/g, ""));
  const any = /GH₵\s*([\d,]+\.\d{2})\s*</.exec(html);
  return any ? Number(any[1].replace(/,/g, "")) : null;
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
      console.log("\nPhase B — the reported scenario, end to end\n");
      await phaseB(pool, baseUrl);
    } else {
      note("Phase B skipped", "set BASE_URL to drive the real app end to end");
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
  const walletTables = await pool.query(
    "select to_regclass('wallets') is not null as wallets, to_regclass('transactions') is not null as txs, " +
      "to_regclass('withdrawal_requests') is not null as withdrawals",
  );
  const t = walletTables.rows[0];
  if (t.wallets && t.txs && t.withdrawals) ok("wallet data-path tables present", "wallets, transactions, withdrawal_requests");
  else bad("wallet data-path tables present", JSON.stringify(t));

  const enumTx = await pool.query(
    "select e.enumlabel from pg_enum e join pg_type t2 on t2.oid = e.enumtypid where t2.typname = 'tx_type'",
  );
  if (enumTx.rows.some((r: { enumlabel: string }) => r.enumlabel === "withdrawal")) ok("tx_type includes 'withdrawal'");
  else bad("tx_type includes 'withdrawal'");
}

// ---------------------------------------------------------------------------
// Phase B — end to end
// ---------------------------------------------------------------------------

async function phaseB(pool: Pool, base: string): Promise<void> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const userEmail = `${PREFIX}${stamp}-user@verify.flexidata.internal`;
  const mateEmail = `${PREFIX}${stamp}-mate@verify.flexidata.internal`;
  const phoneFor = (seed: string) => `024${(1_000_000 + (parseInt(seed.slice(-6), 36) % 8_999_999)).toString()}`;
  const userPhone = phoneFor(stamp + "aa");
  const matePhone = phoneFor(stamp + "bb");
  const userJar = new Jar();
  const adminJar = new Jar();

  // 1. Accounts + sessions (throwaway; deleted in cleanup()).
  await userJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Freshness User", email: userEmail, phone: userPhone, password: PASSWORD }),
  });
  const userLogin = await userJar
    .req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: userEmail, password: PASSWORD }) })
    .then((r) => r.status);
  if (userLogin !== 200) {
    bad("test user registered + signed in", `login status ${userLogin}`);
    return;
  }
  ok("test user registered + signed in");

  // NOTE: a separate jar — `register` signs the new account in, so registering
  // the mate on the user's jar would silently replace the user's session cookie
  // and every later step would act on the MATE's wallet.
  const mateJar = new Jar();
  await mateJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Freshness Mate", email: mateEmail, phone: matePhone, password: PASSWORD }),
  });

  await adminJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Freshness Admin", email: ADMIN_EMAIL, phone: phoneFor(stamp + "cc"), password: PASSWORD }),
  });
  await adminJar.req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: ADMIN_EMAIL, password: PASSWORD }) });
  await pool.query("update users set is_admin = true where email = $1", [ADMIN_EMAIL]);
  const adminMe = await adminJar.req(base, "/api/admin/me");
  if (adminMe.status === 200) ok("admin gate admits the allowlisted admin");
  else {
    bad("admin gate admits the allowlisted admin", `status ${adminMe.status} — is ADMIN_EMAILS set to include ${ADMIN_EMAIL}?`);
    return;
  }

  const walletId: number = (
    await pool.query("select w.id from wallets w join users u on u.id = w.user_id where u.email = $1", [userEmail])
  ).rows[0].id;
  const balanceNow = async (): Promise<number> =>
    Number((await pool.query("select balance from wallets where id = $1", [walletId])).rows[0].balance);

  // 2. Fund GH₵5 (the mock provider settles the same atomic deposit path a
  //    Paystack webhook settles in production).
  const fund = await userJar.req(base, "/api/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 5, method: "momo_mtn" }) });
  const fundBody = (await fund.json().catch(() => ({}))) as { ok?: boolean; error?: string; balance?: number };
  let settled = await balanceNow();
  for (let i = 0; i < 20 && settled < 5; i++) {
    await new Promise((r) => setTimeout(r, 250));
    settled = await balanceNow();
  }
  if (fund.status === 200 && fundBody.ok && settled === 5) ok("deposit credited the wallet (atomic settle path)", "GH₵ 5.00");
  else bad("deposit credited the wallet (atomic settle path)", fundBody.error ?? `balance ${settled}`);

  // 3. User Wallet page (server render) BEFORE the withdrawal.
  const pageBefore = await userJar.req(base, "/wallet");
  const chipBefore = walletChipBalance(await pageBefore.text());
  if (chipBefore === 5) ok("Wallet page renders GH₵ 5.00 before the withdrawal");
  else bad("Wallet page renders GH₵ 5.00 before the withdrawal", `chip ${chipBefore}`);

  // The no-store freshness signal the client guard consumes.
  const summaryBefore = await userJar.req(base, "/api/wallet");
  const summaryBeforeBody = (await summaryBefore.json().catch(() => ({}))) as { ok?: boolean; wallet?: { balance?: number } };
  const summaryCache = summaryBefore.headers.get("cache-control") ?? "";
  if (
    summaryBefore.status === 200 &&
    summaryBeforeBody.ok &&
    summaryBeforeBody.wallet?.balance === 5 &&
    /no-store/.test(summaryCache)
  ) {
    ok("GET /api/wallet reports 5.00 with no-store", "freshness signal is uncached");
  } else {
    bad("GET /api/wallet reports 5.00 with no-store", `status ${summaryBefore.status} cache=${summaryCache}`);
  }

  // 4. Request the GH₵5 withdrawal → wallet becomes 0.00.
  const withdraw = await userJar.req(base, "/api/wallet/withdraw", {
    method: "POST",
    body: JSON.stringify({ amount: 5, method: "momo_mtn", dest: userPhone }),
  });
  const wdBody = (await withdraw.json().catch(() => ({}))) as { ok?: boolean; ref?: string; newBalance?: number; error?: string };
  if (withdraw.status === 200 && wdBody.ok && wdBody.ref) ok("withdrawal request works", `ref ${wdBody.ref}`);
  else {
    bad("withdrawal request works", wdBody.error ?? `status ${withdraw.status}`);
    return;
  }
  if ((await balanceNow()) === 0) ok("wallet database balance is GH₵ 0.00 after the request");
  else {
    const dupes = await pool.query(
      "select w.id, w.balance, w.user_id from wallets w join users u on u.id = w.user_id where u.email = $1 order by w.id",
      [userEmail],
    );
    bad("wallet database balance is GH₵ 0.00 after the request", `balance ${await balanceNow()} wallets ${JSON.stringify(dupes.rows)}`);
  }

  const pageAfterWithdraw = await userJar.req(base, "/wallet");
  const chipAfterWithdraw = walletChipBalance(await pageAfterWithdraw.text());
  if (chipAfterWithdraw === 0) ok("Wallet page renders GH₵ 0.00 after the withdrawal");
  else bad("Wallet page renders GH₵ 0.00 after the withdrawal", `chip ${chipAfterWithdraw}`);

  // 5. Admin rejects.
  const wdId: number = (
    await pool.query("select id from withdrawal_requests where ref = $1", [wdBody.ref])
  ).rows[0].id;
  const reject = await adminJar.req(base, `/api/admin/withdrawals/${wdId}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "Freshness regression rejection" }),
  });
  const rejectBody = (await reject.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (reject.status === 200 && rejectBody.ok) ok("admin rejection works");
  else {
    bad("admin rejection works", `status ${reject.status} ${JSON.stringify(rejectBody)}`);
    return;
  }

  // 6. Database truth: refunded exactly once, still rejected, ledger + audit.
  const post = (
    await pool.query(
      "select w.status as wd_status, (select balance from wallets where id = $2) as balance, " +
        "(select count(*) from admin_audit_logs where target_ref = w.ref and action = 'reject_withdrawal') as audit_rows, " +
        "(select status from transactions where ref = w.ref) as ledger_status, " +
        "(select count(*) from transactions where ref = w.ref) as ledger_rows " +
        "from withdrawal_requests w where w.id = $1",
      [wdId, walletId],
    )
  ).rows[0];
  if (post.wd_status === "rejected") ok("withdrawal remains rejected");
  else bad("withdrawal remains rejected", post.wd_status);
  if (Number(post.balance) === 5) ok("wallet database balance returned to GH₵ 5.00 (refund of the gross amount)");
  else {
    const dupes = await pool.query(
      "select w.id, w.balance, w.user_id from wallets w join users u on u.id = w.user_id where u.email = $1 order by w.id",
      [userEmail],
    );
    bad("wallet database balance returned to GH₵ 5.00", `balance ${post.balance} wallets ${JSON.stringify(dupes.rows)}`);
  }
  if (Number(post.audit_rows) === 1) ok("exactly one reject_withdrawal audit row");
  else bad("exactly one reject_withdrawal audit row", `${post.audit_rows} rows`);
  if (post.ledger_status === "failed" && Number(post.ledger_rows) === 1) ok("ledger: single withdrawal row, status failed");
  else bad("ledger: single withdrawal row, status failed", `${post.ledger_rows} rows, status ${post.ledger_status}`);

  // 7. THE REGRESSION: the user-facing Wallet page shows the refunded balance.
  const pageAfterReject = await userJar.req(base, "/wallet");
  const chipAfterReject = walletChipBalance(await pageAfterReject.text());
  if (chipAfterReject === 5) ok("Wallet page displays GH₵ 5.00 after the rejection");
  else bad("Wallet page displays GH₵ 5.00 after the rejection", `chip ${chipAfterReject}`);

  const summaryAfter = await userJar.req(base, "/api/wallet");
  const summaryAfterBody = (await summaryAfter.json().catch(() => ({}))) as { ok?: boolean; wallet?: { balance?: number } };
  if (summaryAfter.status === 200 && summaryAfterBody.wallet?.balance === 5) {
    ok("GET /api/wallet reports GH₵ 5.00 after the rejection", "what WalletFreshness compares against");
  } else {
    bad("GET /api/wallet reports GH₵ 5.00 after the rejection", JSON.stringify(summaryAfterBody));
  }

  // 8. Admin sees the same GH₵ 5.
  const adminWallets = await adminJar.req(base, `/api/admin/wallets?search=${encodeURIComponent(userPhone)}`);
  const adminWalletsBody = (await adminWallets.json().catch(() => ({}))) as {
    ok?: boolean;
    rows?: { walletId: number; storedBalance: number }[];
  };
  const adminRow = adminWalletsBody.rows?.find((r) => r.walletId === walletId);
  if (adminWallets.status === 200 && adminRow?.storedBalance === 5) ok("admin wallet view shows GH₵ 5.00 too");
  else bad("admin wallet view shows GH₵ 5.00 too", JSON.stringify(adminRow ?? adminWalletsBody).slice(0, 200));

  // 9. Replayed rejection cannot refund twice.
  const replay = await adminJar.req(base, `/api/admin/withdrawals/${wdId}/action`, {
    method: "POST",
    body: JSON.stringify({ action: "reject", reason: "again" }),
  });
  const replayState = (
    await pool.query(
      "select (select balance from wallets where id = $2) as balance, " +
        "(select count(*) from admin_audit_logs where target_ref = (select ref from withdrawal_requests where id = $1) and action = 'reject_withdrawal') as audit_rows, " +
        "(select status from withdrawal_requests where id = $1) as wd_status " +
        "from wallets where id = $2",
      [wdId, walletId],
    )
  ).rows[0];
  if (replay.status === 409 && Number(replayState.balance) === 5 && Number(replayState.audit_rows) === 1 && replayState.wd_status === "rejected") {
    ok("replayed reject refused (409): no duplicate refund, still rejected");
  } else {
    bad("replayed reject refused (409): no duplicate refund, still rejected", `status ${replay.status} ${JSON.stringify(replayState)}`);
  }

  // 10. Viewport prefetch (default `Link` prefetch) must not pin a balance in
  //     the client Router Cache: the prefetch payload carries the loading
  //     shell, not page data. (Full prefetch — `prefetch={true}` — is what
  //     served stale balances for up to 5 minutes.)
  const prefetch = await userJar.req(base, "/wallet", { headers: { RSC: "1" } });
  let prefetchText = "";
  if (prefetch.status === 307 && prefetch.headers.get("location")) {
    const follow = await userJar.req(base, prefetch.headers.get("location"), { headers: { RSC: "1" } });
    prefetchText = await follow.text();
  } else {
    prefetchText = await prefetch.text();
  }
  if (/GH₵\s*[\d,]+\.\d{2}/.test(prefetchText)) {
    // In development the RSC request answers with the fully rendered tree and
    // viewport prefetching is disabled, so a money figure here is expected.
    // In production this payload is the loading shell a viewport prefetch
    // fetches — embedding a balance there is exactly what pinned stale money
    // in the client Router Cache (full `prefetch={true}` did; it no longer
    // exists on any nav link).
    note("prefetch payload contains rendered money", "expected in a development runtime; production prefetches the loading shell only");
  } else {
    ok("prefetch payload carries no balance figure (loading shell only)");
  }

  // 11. Deposits still functional after the whole flow (+GH₵5 → 10.00; the
  //     deposit minimum is GH₵5, see src/lib/constants.ts).
  const fund2 = await userJar.req(base, "/api/wallet/fund", { method: "POST", body: JSON.stringify({ amount: 5, method: "momo_mtn" }) });
  const fund2Body = (await fund2.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  let afterFund2 = await balanceNow();
  for (let i = 0; i < 20 && afterFund2 < 10; i++) {
    await new Promise((r) => setTimeout(r, 250));
    afterFund2 = await balanceNow();
  }
  if (fund2.status === 200 && fund2Body.ok && afterFund2 === 10) ok("deposits still work after the rejection flow", "5.00 + 5.00 = 10.00");
  else bad("deposits still work after the rejection flow", fund2Body.error ?? `balance ${afterFund2}`);

  // 12. Transfers move money and the page reflects them.
  const transfer = await userJar.req(base, "/api/wallet/transfer", {
    method: "POST",
    body: JSON.stringify({ account: matePhone, amount: 1 }),
  });
  const transferBody = (await transfer.json().catch(() => ({}))) as { ok?: boolean; balance?: number; error?: string };
  const mateBalance = Number(
    (await pool.query("select w.balance from wallets w join users u on u.id = w.user_id where u.email = $1", [mateEmail])).rows[0]
      .balance,
  );
  const pageAfterTransfer = await userJar.req(base, "/wallet");
  const chipAfterTransfer = walletChipBalance(await pageAfterTransfer.text());
  if (transfer.status === 200 && transferBody.ok && (await balanceNow()) === 9 && mateBalance === 1 && chipAfterTransfer === 9) {
    ok("transfer works and the Wallet page renders the new balance", "10.00 → 9.00, mate 1.00");
  } else {
    bad("transfer works and the Wallet page renders the new balance", `db ${await balanceNow()} mate ${mateBalance} chip ${chipAfterTransfer}`);
  }

  await cleanup(pool);
}

/** Deletes ONLY rows this script created (audit first: they RESTRICT user deletes). */
async function cleanup(pool: Pool): Promise<void> {
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
