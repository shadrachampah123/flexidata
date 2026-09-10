/**
 * Withdrawal kill-switch suite — `WITHDRAWALS_ENABLED` (temporary).
 *
 * Proves the ENTIRE withdrawal/payout feature is inactive unless the flag is
 * explicitly `true`, and that the payout implementation itself is intact for
 * future reactivation:
 *
 *   K1  the flag is fail-closed: missing → disabled
 *   K2  the flag is fail-closed: `false` (and every other non-`true` value,
 *       including the repo's usual `1`/`yes`/`on`) → disabled
 *   K3  explicit `true` → enabled
 *   K4  new withdrawal creation is refused while disabled (before validation,
 *       debit, row, ledger, provider — live drive)
 *   K5  the wallet is not debited while disabled (live drive)
 *   K6  no withdrawal row is created while disabled (live drive)
 *   K7  admin approve is blocked while disabled (live drive)
 *   K8  admin retry is blocked while disabled (live drive)
 *   K9  payout execution cannot reach Paystack while disabled — no recipient
 *       is created and no transfer is initiated, on ANY entry path, with a
 *       fetch spy proving zero network I/O
 *   K10 the system stays intact: enabled + mock provider still executes, the
 *       transfers-flag layering is unchanged, and historical reads +
 *       reject/refund reconciliation keep working while disabled
 *
 * Layout:
 *   Phase A — in-memory flag matrix, guard behavior, payout-refusal with a
 *             fetch spy, enabled-path sanity, and route/lib/UI wiring checks
 *             (no env needed).
 *   Phase B — live drive of the REAL API (needs DATABASE_URL + BASE_URL with
 *             an app server running withdrawals DISABLED):
 *
 *   # from the flexiData directory — note WITHDRAWALS_ENABLED is ABSENT (off):
 *   DATABASE_URL='postgresql://…' PAYMENTS_PROVIDER=mock \
 *   ADMIN_EMAILS='fd-ks-admin@verify.flexidata.internal' \
 *   AUTH_SECRET='<random>' npm run dev -- --port 3000
 *   DATABASE_URL='postgresql://…' BASE_URL='http://127.0.0.1:3000' \
 *     npm run verify:withdrawals-disabled
 *
 * IMPORTANT: this suite imports server-only app modules, so it must run with
 * the react-server condition (use `npm run verify:withdrawals-disabled`).
 *
 * Safety rules (same as the sibling verify scripts):
 *   * refuses a non-local BASE_URL unless ALLOW_PRODUCTION=1;
 *   * every row it creates is tagged (refs contain `WDL-KS-`, users contain
 *     `fd-ks-`) and is deleted again before exit;
 *   * the genuine live Paystack deposit `DP-MTMZN2P8SSBR` is snapshotted before
 *     and after and must be byte-identical;
 *   * NEVER touches a real Paystack: the fetch spy fails the run if any
 *     provider call attempts network I/O while disabled.
 *
 * Usage from the flexiData directory:
 *   npm run verify:withdrawals-disabled                                        # Phase A only
 *   DATABASE_URL='…' BASE_URL='http://127.0.0.1:3000' npm run verify:withdrawals-disabled  # A + B
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
  assertWithdrawalsEnabled,
  isWithdrawalsEnabled,
  WithdrawalsDisabledError,
  WITHDRAWALS_DISABLED_CODE,
  WITHDRAWALS_DISABLED_MESSAGE,
} from "../src/lib/withdrawal-flag";
import {
  createBankRecipient,
  createMomoRecipient,
  initiateTransfer,
  resetPaystackBankCodeCache,
} from "../src/lib/paystack-transfers";
import { getPayoutProvider, resetPayoutProvider } from "../src/lib/payout-service";
import { executeWithdrawalPayout } from "../src/lib/payout-execution";

const PROTECTED_REF = "DP-MTMZN2P8SSBR";
const ADMIN_EMAIL = "fd-ks-admin@verify.flexidata.internal";
const PREFIX = "fd-ks-";
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
const check = (label: string, cond: boolean, detail = ""): void => {
  if (cond) ok(label, detail);
  else bad(label, detail);
};

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

const ENV_KEYS = [
  "NODE_ENV",
  "WITHDRAWALS_ENABLED",
  "PAYSTACK_TRANSFERS_ENABLED",
  "PAYSTACK_SECRET_KEY",
  "PAYSTACK_BASE_URL",
  "PAYOUT_PROVIDER",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
  resetPayoutProvider();
  resetPaystackBankCodeCache();
}

/** Read a repo file as text (cwd must be flexiData). */
function readRepo(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

// ===========================================================================
// Phase A — fail-closed flag, payout refusal, enabled sanity, wiring
// ===========================================================================

async function phaseA(): Promise<void> {
  console.log("\nPhase A — kill-switch flag, refusal, sanity, wiring (in-memory)\n");

  // --- A1: fail-closed matrix (K1/K2/K3) ------------------------------------
  console.log("--- A1 flag matrix (K1/K2/K3) ---");
  {
    const snap = snapshotEnv();
    try {
      delete process.env.WITHDRAWALS_ENABLED;
      check("missing WITHDRAWALS_ENABLED → disabled (K1)", isWithdrawalsEnabled() === false);
      for (const v of ["false", "", "0", "1", "yes", "on", "no", "off", "enabled", "disabled", "2", "truthy"]) {
        process.env.WITHDRAWALS_ENABLED = v;
        check(`WITHDRAWALS_ENABLED=${JSON.stringify(v)} → disabled (K2)`, isWithdrawalsEnabled() === false);
      }
      process.env.WITHDRAWALS_ENABLED = "true";
      check("WITHDRAWALS_ENABLED=true → enabled (K3)", isWithdrawalsEnabled() === true);
      // Normalization only (trimmed, case-insensitive) — the truthy set is
      // still exactly { "true" }: "1"/"yes"/"on" above stay disabled.
      for (const v of ["TRUE", " True ", "tRuE"]) {
        process.env.WITHDRAWALS_ENABLED = v;
        check(`WITHDRAWALS_ENABLED=${JSON.stringify(v)} → enabled (normalization)`, isWithdrawalsEnabled() === true);
      }
    } finally {
      restoreEnv(snap);
    }
  }

  // --- A2: the guard error contract ------------------------------------------
  console.log("\n--- A2 guard error contract ---");
  {
    const snap = snapshotEnv();
    try {
      delete process.env.WITHDRAWALS_ENABLED;
      try {
        assertWithdrawalsEnabled();
        bad("assertWithdrawalsEnabled throws while disabled", "did not throw");
      } catch (e) {
        check("throws WithdrawalsDisabledError", e instanceof WithdrawalsDisabledError, (e as Error)?.name ?? "?");
        check(
          "error carries the withdrawals_disabled code",
          (e as WithdrawalsDisabledError)?.code === WITHDRAWALS_DISABLED_CODE,
        );
        check(
          "error message names the outage",
          /temporarily unavailable/i.test((e as Error)?.message ?? ""),
          (e as Error)?.message?.slice(0, 60) ?? "?",
        );
      }
      check(
        "UI line is exactly “Withdrawals are temporarily unavailable.”",
        WITHDRAWALS_DISABLED_MESSAGE === "Withdrawals are temporarily unavailable.",
      );
      process.env.WITHDRAWALS_ENABLED = "true";
      let threw = false;
      try {
        assertWithdrawalsEnabled();
      } catch {
        threw = true;
      }
      check("assertWithdrawalsEnabled passes while enabled", threw === false);
    } finally {
      restoreEnv(snap);
    }
  }

  // --- A3: payout execution cannot reach Paystack while disabled (K9) --------
  console.log("\n--- A3 payout refusal before any network I/O (K9) ---");
  for (const flag of [undefined, "false"] as const) {
    const snap = snapshotEnv();
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network reached while withdrawals disabled");
    }) as typeof fetch;
    try {
      process.env.NODE_ENV = "test";
      if (flag === undefined) delete process.env.WITHDRAWALS_ENABLED;
      else process.env.WITHDRAWALS_ENABLED = flag;
      // Everything ELSE is configured for real payouts, so the kill switch is
      // the only thing standing between these calls and the network.
      process.env.PAYOUT_PROVIDER = "paystack-transfers";
      process.env.PAYSTACK_TRANSFERS_ENABLED = "true";
      process.env.PAYSTACK_SECRET_KEY = "sk_test_killswitch_probe_key";
      process.env.PAYSTACK_BASE_URL = "http://127.0.0.1:9";
      resetPayoutProvider();
      resetPaystackBankCodeCache();

      const tag = flag === undefined ? "missing" : "false";
      const expectDisabled = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        try {
          await fn();
          bad(`${label} refuses while disabled [${tag}]`, "did not throw");
        } catch (e) {
          check(
            `${label} refuses while disabled [${tag}]`,
            e instanceof WithdrawalsDisabledError,
            e instanceof Error ? `${e.name}: ${e.message.slice(0, 50)}` : String(e),
          );
        }
      };

      // Lowest Paystack layer — valid inputs, so only the kill switch refuses.
      await expectDisabled("initiateTransfer", () =>
        initiateTransfer({ amountPesewas: 490, recipientCode: "RCP_probe", reference: "WDL-KS-PROBE", reason: "probe" }),
      );
      await expectDisabled("createMomoRecipient", () =>
        createMomoRecipient({ method: "momo_mtn", destination: "0244123456", accountName: "Kill Switch Probe" }),
      );
      await expectDisabled("createBankRecipient", () =>
        createBankRecipient({ bankCode: "GCB", accountNumber: "1234567890", accountName: "Kill Switch Probe" }),
      );

      // Provider adapters (real + mock).
      resetPayoutProvider();
      const paystack = getPayoutProvider();
      check(`paystack adapter resolved [${tag}]`, paystack.name === "paystack-transfers");
      await expectDisabled("paystack createPayout", () =>
        paystack.createPayout({
          withdrawalRef: "WDL-KS-PROBE",
          amount: "4.90",
          currency: "GHS",
          method: "momo_mtn",
          destination: "0244123456",
          network: "MTN",
        }),
      );
      delete process.env.PAYOUT_PROVIDER;
      resetPayoutProvider();
      const mock = getPayoutProvider();
      check(`mock adapter resolved [${tag}]`, mock.name === "mock");
      await expectDisabled("mock createPayout (simulated payouts blocked too)", () =>
        mock.createPayout({
          withdrawalRef: "WDL-KS-PROBE",
          amount: "4.90",
          currency: "GHS",
          method: "momo_mtn",
          destination: "0244123456",
          network: "MTN",
        }),
      );

      // The execution choke point — a bare `{}` tx proves the guard fires
      // before ANY database or provider interaction.
      await expectDisabled("executeWithdrawalPayout", () =>
        executeWithdrawalPayout({} as never, { status: "processing" } as never, { type: "system" }),
      );

      check(`zero network I/O across all refusal paths [${tag}]`, fetchCalls === 0, `${fetchCalls} fetch call(s)`);
    } finally {
      globalThis.fetch = realFetch;
      restoreEnv(snap);
    }
  }

  // --- A4: the system stays intact while enabled (K10, in-memory half) ------
  console.log("\n--- A4 enabled-path sanity: payout system intact (K10) ---");
  {
    const snap = snapshotEnv();
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("unexpected network I/O in mock sanity run");
    }) as typeof fetch;
    try {
      process.env.NODE_ENV = "test";
      process.env.WITHDRAWALS_ENABLED = "true";
      delete process.env.PAYOUT_PROVIDER;
      delete process.env.PAYSTACK_TRANSFERS_ENABLED;
      process.env.PAYSTACK_SECRET_KEY = "sk_test_killswitch_probe_key";
      resetPayoutProvider();
      resetPaystackBankCodeCache();

      const fakeTx = {
        update: () => ({ set: () => ({ where: async () => undefined }) }),
        execute: async () => ({ rows: [] as unknown[] }),
      };
      const row = {
        id: 1,
        ref: "WDL-KS-SANITY",
        status: "processing",
        providerReference: null,
        providerStatus: null,
        providerPayload: {},
        destinationMethod: "momo_mtn",
        destinationDetails: { account: "0244123456", network: "MTN", method: "momo_mtn" },
        netAmount: "4.90",
        currency: "GHS",
      };
      const attempt = await executeWithdrawalPayout(fakeTx as never, row as never, { type: "system" });
      check("enabled + mock executes (outcome initiated)", attempt.outcome === "initiated", attempt.message.slice(0, 60));
      check(
        "mock transfer code minted",
        (attempt.providerReference ?? "").startsWith("MOCK-"),
        attempt.providerReference ?? "?",
      );
      check("mock sanity run made no network calls", fetchCalls === 0);

      // The transfers-flag layer underneath is unchanged: withdrawals on +
      // transfers off still refuses with the transfers error (not silently).
      delete process.env.PAYSTACK_TRANSFERS_ENABLED;
      resetPayoutProvider();
      resetPaystackBankCodeCache();
      try {
        await initiateTransfer({ amountPesewas: 100, recipientCode: "RCP_x", reference: "WDL-X", reason: "t" });
        bad("transfers-flag layer intact while enabled", "did not throw");
      } catch (e) {
        check(
          "transfers-flag layer intact while enabled",
          (e as Error)?.name === "PaystackConfigError",
          (e as Error)?.name ?? "?",
        );
      }
    } finally {
      globalThis.fetch = realFetch;
      restoreEnv(snap);
    }
  }

  // --- A5: route/lib/UI wiring (static) --------------------------------------
  console.log("\n--- A5 server + UI wiring (static) ---");
  {
    // Creation route: guarded before body parsing, validation, idempotency,
    // debit, row, and ledger — with a 503 + machine-readable code.
    const withdraw = readRepo("src/app/api/wallet/withdraw/route.ts");
    check("withdraw route imports the kill switch", withdraw.includes('@/lib/withdrawal-flag"'));
    check("withdraw route answers withdrawals_disabled", withdraw.includes("WITHDRAWALS_DISABLED_CODE"));
    check("withdraw route refuses with 503", withdraw.includes("status: 503"));
    const wGuard = withdraw.indexOf("isWithdrawalsEnabled()");
    check(
      "withdraw guard runs before body parsing",
      wGuard !== -1 && wGuard < withdraw.indexOf("await req.json()"),
    );
    check(
      "withdraw guard runs before validation",
      wGuard !== -1 && wGuard < withdraw.indexOf("validateWithdrawalRequestBody(body)"),
    );
    check(
      "withdraw guard runs before the idempotency lookup",
      wGuard !== -1 && wGuard < withdraw.indexOf("await findWithdrawalByIdempotency("),
    );
    check(
      "withdraw guard runs before the money transaction",
      wGuard !== -1 && wGuard < withdraw.indexOf("db.transaction"),
    );

    // Admin route: approve + retry gated, reject/refund NOT gated.
    const action = readRepo("src/app/api/admin/withdrawals/[id]/action/route.ts");
    check("admin action route imports the kill switch", action.includes('@/lib/withdrawal-flag"'));
    check(
      "admin gate covers exactly approve + retry",
      action.includes('adminAction === "approve" || adminAction === "retry"'),
    );
    const aGuard = action.indexOf("isWithdrawalsEnabled()");
    check(
      "admin gate runs before the money transaction",
      aGuard !== -1 && aGuard < action.indexOf("db.transaction"),
    );
    check("admin gate answers withdrawals_disabled with 503", action.includes("WITHDRAWALS_DISABLED_CODE") && action.includes("status: 503"));
    check(
      "reject/refund stay ungated (reconciliation intact)",
      !/adminAction === "reject"[^]*?isWithdrawalsEnabled|adminAction === "refund"[^]*?isWithdrawalsEnabled/.test(
        action.slice(Math.max(0, aGuard - 400), aGuard + 400),
      ) && action.includes('adminAction === "reject" || adminAction === "refund"'),
    );

    // Payout layers: guarded before any provider/network touch.
    const execution = readRepo("src/lib/payout-execution.ts");
    const eGuard = execution.indexOf("assertWithdrawalsEnabled()");
    check("payout execution asserts the kill switch", eGuard !== -1);
    check(
      "execution guard runs before provider resolution",
      eGuard !== -1 && eGuard < execution.indexOf("getPayoutProvider()"),
    );
    const service = readRepo("src/lib/payout-service.ts");
    check(
      "both provider adapters gate createPayout",
      (service.match(/assertWithdrawalsEnabled\(\)/g) ?? []).length >= 2,
    );
    const transfers = readRepo("src/lib/paystack-transfers.ts");
    check(
      "all three creation entries gate the kill switch",
      (transfers.match(/assertWithdrawalsEnabled\(\)/g) ?? []).length >= 3,
    );

    // Callback + reconciliation + reads stay ungated (historical integrity).
    const callback = readRepo("src/app/api/payouts/callback/route.ts");
    check("provider callback stays ungated (settles in-flight payouts)", !callback.includes("isWithdrawalsEnabled"));
    const recon = readRepo("src/lib/payout-reconciliation.ts");
    check("reconciliation stays ungated (historical review intact)", !recon.includes("isWithdrawalsEnabled"));
    check(
      "status reads stay ungated (fetchTransfer)",
      !/assertWithdrawalsEnabled[\s\S]{0,200}export async function fetchTransfer/.test(transfers) &&
        transfers.includes("export async function fetchTransfer"),
    );
    const history = readRepo("src/app/api/wallet/withdrawals/route.ts");
    check("user history stays ungated (records visible)", !history.includes("isWithdrawalsEnabled"));

    // Deposits, transfers, purchases: untouched by the switch.
    for (const f of [
      "src/app/api/wallet/fund/route.ts",
      "src/app/api/wallet/transfer/route.ts",
      "src/lib/deposits.ts",
      "src/lib/payments.ts",
    ]) {
      check(`${f} has no withdrawal gate`, !readRepo(f).includes("isWithdrawalsEnabled"));
    }

    // UI: explicit notice (never a hidden button) + history stays visible.
    const tools = readRepo("src/components/wallet-tools.tsx");
    check("wallet UI shows “Withdrawals are temporarily unavailable.”", tools.includes("Withdrawals are temporarily unavailable."));
    check("wallet UI takes a server-resolved withdrawalsEnabled prop", tools.includes("withdrawalsEnabled"));
    check("wallet CTA degrades to a disabled “Withdrawals unavailable”", tools.includes('"Withdrawals unavailable"'));
    const walletPage = readRepo("src/app/wallet/page.tsx");
    check("wallet page resolves the flag server-side", walletPage.includes("isWithdrawalsEnabled()"));
    const explorer = readRepo("src/components/admin/withdrawals-explorer.tsx");
    check("admin explorer disables approve/retry while off", explorer.includes("withdrawalsDisabled"));
    const adminPage = readRepo("src/app/admin/withdrawals/page.tsx");
    check("admin page banners the outage server-side", adminPage.includes("withdrawalsDisabled"));

    // Flag default + health reporting.
    check(".env.example pins WITHDRAWALS_ENABLED=false", readRepo(".env.example").includes("WITHDRAWALS_ENABLED=false"));
    const health = readRepo("src/app/api/health/route.ts");
    check("/api/health reports withdrawals.enabled", health.includes("withdrawalsEnabled"));
  }
}

// ===========================================================================
// Phase B — live drive of the REAL API (withdrawals DISABLED server)
// ===========================================================================

type Track = { userEmails: string[]; withdrawalRefs: string[]; depositRefs: string[] };

async function protectedSnapshot(pool: Pool): Promise<string> {
  const dep = await pool.query(
    "select id, ref, wallet_id, provider, method, amount::text as amount, amount_subunits, currency, status::text as status, provider_reference, paystack_transaction_id from deposit_requests where ref = $1",
    [PROTECTED_REF],
  );
  if (dep.rows.length === 0) return "absent";
  const w = await pool.query("select id, balance::text as balance from wallets where id = $1", [dep.rows[0].wallet_id]);
  const tx = await pool.query(
    "select ref, type::text as type, status::text as status, amount::text as amount from transactions where ref = $1 order by id",
    [PROTECTED_REF],
  );
  return JSON.stringify({ dep: dep.rows[0], wallet: w.rows[0] ?? null, tx: tx.rows });
}

async function cleanup(pool: Pool, track: Track): Promise<void> {
  if (track.withdrawalRefs.length > 0) {
    await pool.query("delete from withdrawal_audit_logs where withdrawal_ref = any($1)", [track.withdrawalRefs]);
    await pool.query("delete from payout_reconciliation_exceptions where withdrawal_ref = any($1)", [track.withdrawalRefs]);
    await pool.query("delete from withdrawal_requests where ref = any($1)", [track.withdrawalRefs]);
    await pool.query("delete from transactions where ref = any($1)", [track.withdrawalRefs]);
  }
  if (track.depositRefs.length > 0) {
    await pool.query("delete from deposit_requests where ref = any($1)", [track.depositRefs]);
    await pool.query("delete from transactions where ref = any($1)", [track.depositRefs]);
  }
  if (track.userEmails.length > 0) {
    await pool.query("delete from admin_audit_logs where target_ref = any($1)", [
      track.withdrawalRefs.length ? track.withdrawalRefs : ["__none__"],
    ]);
    const ids = (await pool.query("select id from users where email = any($1)", [track.userEmails])).rows.map(
      (r) => r.id as number,
    );
    if (ids.length > 0) {
      await pool.query("delete from admin_audit_logs where admin_user_id = any($1) or target_user_id = any($1)", [ids]);
      await pool.query("delete from sessions where user_id = any($1)", [ids]);
      await pool.query("delete from wallets where user_id = any($1)", [ids]);
      await pool.query("delete from users where id = any($1)", [ids]);
    }
  }
}

async function phaseB(base: string, pool: Pool, track: Track): Promise<void> {
  console.log("\nPhase B — live drive: creation/approval/retry blocked, wallet untouched (REAL app server)\n");
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`.toUpperCase();
  const ref = (tag: string) => `WDL-KS-${stamp}-${tag}`.slice(0, 40);
  const phoneOf = (n: number): string => `024${String(1000000 + ((parseInt(stamp.slice(-6), 36) + n * 7919) % 8999999))}`;

  // --- B0: server preconditions ----------------------------------------------
  console.log("--- B0 server preconditions ---");
  const healthRes = await fetch(`${base}/api/health`);
  const health = (await healthRes.json().catch(() => ({}))) as { withdrawals?: { enabled?: boolean } };
  check("server reports withdrawals.enabled === false", health.withdrawals?.enabled === false, JSON.stringify(health.withdrawals ?? null));
  if (health.withdrawals?.enabled !== false) {
    bad("Phase B aborted", "start the app with withdrawals DISABLED (WITHDRAWALS_ENABLED unset or false)");
    return;
  }

  const adminJar = new Jar();
  await adminJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Ks Admin", email: ADMIN_EMAIL, phone: phoneOf(1), password: PASSWORD }),
  });
  await adminJar.req(base, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier: ADMIN_EMAIL, password: PASSWORD }),
  });
  await pool.query("update users set is_admin = true where email = $1", [ADMIN_EMAIL]);
  track.userEmails.push(ADMIN_EMAIL);
  const adminMe = await adminJar.req(base, "/api/admin/me");
  check("admin gate admits the suite admin", adminMe.status === 200, `status ${adminMe.status} (app needs ADMIN_EMAILS=${ADMIN_EMAIL})`);
  if (adminMe.status !== 200) {
    bad("Phase B aborted", "admin gate refused — start the app with the documented ADMIN_EMAILS");
    return;
  }

  const jar = new Jar();
  const email = `${PREFIX}${stamp.toLowerCase()}@verify.flexidata.internal`;
  const phone = phoneOf(2);
  const reg = await jar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Ks User", email, phone, password: PASSWORD }),
  });
  if (reg.status !== 200 && reg.status !== 201) {
    bad("register kill-switch user", `status ${reg.status} ${(await reg.text()).slice(0, 120)}`);
    return;
  }
  await jar.req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: email, password: PASSWORD }) });
  track.userEmails.push(email);
  const walletId = Number(
    (await pool.query("select w.id from wallets w join users u on u.id = w.user_id where u.email = $1", [email])).rows[0].id,
  );
  const userId = Number((await pool.query("select id from users where email = $1", [email])).rows[0].id);

  const fund = await jar.req(base, "/api/wallet/fund", { method: "POST", body: JSON.stringify({ method: "momo_mtn", amount: 50 }) });
  const fundBody = (await fund.json().catch(() => ({}))) as { status?: string; ref?: string };
  check("user funded GH₵50 (mock instant — deposits unaffected)", fund.status === 200 && fundBody.status === "successful");
  if (!(fund.status === 200 && fundBody.status === "successful")) {
    bad("Phase B aborted", "point BASE_URL at a mock-funding server (PAYMENTS_PROVIDER=mock)");
    return;
  }
  if (typeof fundBody.ref === "string") track.depositRefs.push(fundBody.ref);

  const balanceOf = async (): Promise<number> =>
    Number((await pool.query("select balance from wallets where id = $1", [walletId])).rows[0].balance);
  const wdCount = async (): Promise<number> =>
    Number((await pool.query("select count(*)::int as n from withdrawal_requests where wallet_id = $1", [walletId])).rows[0].n);
  const txCount = async (): Promise<number> =>
    Number((await pool.query("select count(*)::int as n from transactions where wallet_id = $1", [walletId])).rows[0].n);

  // --- B1: creation blocked, wallet + tables untouched (K4/K5/K6) ------------
  console.log("\n--- B1 creation blocked, nothing moves (K4/K5/K6) ---");
  const balBefore = await balanceOf();
  const wdBefore = await wdCount();
  const txBefore = await txCount();
  const created = await jar.req(base, "/api/wallet/withdraw", {
    method: "POST",
    body: JSON.stringify({ amount: "10", method: "momo_mtn", dest: phone, idempotencyKey: `ks-${stamp}-a` }),
  });
  const createdBody = (await created.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string };
  check("POST /api/wallet/withdraw → 503", created.status === 503, `status ${created.status}`);
  check("refusal code is withdrawals_disabled", createdBody.code === "withdrawals_disabled", String(createdBody.code));
  check(
    "refusal error names the outage",
    /temporarily unavailable/i.test(createdBody.error ?? ""),
    (createdBody.error ?? "").slice(0, 80),
  );
  check("wallet is not debited (K5)", (await balanceOf()) === balBefore, `${balBefore} → ${await balanceOf()}`);
  check("no withdrawal row is created (K6)", (await wdCount()) === wdBefore);
  check("no ledger row is created", (await txCount()) === txBefore);

  // --- B2: admin approve + retry blocked (K7/K8) ------------------------------
  console.log("\n--- B2 admin approve + retry blocked (K7/K8) ---");
  const pendingRef = ref("PEND");
  await pool.query(
    `insert into withdrawal_requests
       (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status, idempotency_key, currency)
     values ($1, $2, $3, '5.00', '0.10', '4.90', 'momo_mtn', $4, 'pending', $5, 'GHS')`,
    [pendingRef, userId, walletId, JSON.stringify({ account: phone, network: "MTN", method: "momo_mtn" }), `ks-key-${stamp}-p`],
  );
  track.withdrawalRefs.push(pendingRef);
  const pendingId = Number((await pool.query("select id from withdrawal_requests where ref = $1", [pendingRef])).rows[0].id);
  const adminAction = async (id: number, action: string, reason = ""): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await adminJar.req(base, `/api/admin/withdrawals/${id}/action`, {
      method: "POST",
      body: JSON.stringify({ action, reason }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const ap = await adminAction(pendingId, "approve");
  check("approve → 503 withdrawals_disabled (K7)", ap.status === 503 && ap.body.code === "withdrawals_disabled", `status ${ap.status}`);
  const stillPending = (await pool.query("select status::text as s from withdrawal_requests where ref = $1", [pendingRef])).rows[0].s;
  check("blocked approve changes nothing (still pending)", stillPending === "pending");
  const approveAudit = await pool.query("select count(*)::int as n from admin_audit_logs where target_ref = $1", [pendingRef]);
  check("blocked approve writes no audit claim", (approveAudit.rows[0]?.n as number) === 0);

  await pool.query("update withdrawal_requests set status = 'processing', provider_status = 'awaiting_provider' where ref = $1", [pendingRef]);
  const rt = await adminAction(pendingId, "retry");
  check("retry → 503 withdrawals_disabled (K8)", rt.status === 503 && rt.body.code === "withdrawals_disabled", `status ${rt.status}`);
  const stillProcessing = (await pool.query("select status::text as s, provider_reference as p from withdrawal_requests where ref = $1", [pendingRef])).rows[0];
  check("blocked retry changes nothing (still processing, no transfer)", stillProcessing.s === "processing" && stillProcessing.p === null);

  // --- B3: history visible, reject/refund reconciliation intact (K10) ---------
  console.log("\n--- B3 history visible + reject intact (K10) ---");
  const listRes = await jar.req(base, "/api/wallet/withdrawals");
  const listBody = (await listRes.json().catch(() => ({}))) as { ok?: boolean; withdrawals?: Array<{ ref: string }> };
  check(
    "user history still lists the record",
    listRes.status === 200 && (listBody.withdrawals ?? []).some((w) => w.ref === pendingRef),
    `status ${listRes.status}`,
  );
  const adminListRes = await adminJar.req(base, `/api/admin/withdrawals?search=${encodeURIComponent(pendingRef)}`);
  check("admin list still lists the record", adminListRes.status === 200 && JSON.stringify(await adminListRes.json().catch(() => ({}))).includes(pendingRef));

  // Reject path (reconciliation) still functions end to end on a fully-formed
  // pending fixture: deducted wallet + pending ledger row + pending request.
  const rejRef = ref("REJ");
  await pool.query("update wallets set balance = balance - '5.00' where id = $1", [walletId]);
  await pool.query(
    `insert into transactions (ref, wallet_id, type, status, direction, title, subtitle, amount)
     values ($1, $2, 'withdrawal', 'pending', 'out', 'Withdrawal Request', 'kill-switch probe', '5.00')`,
    [rejRef, walletId],
  );
  await pool.query(
    `insert into withdrawal_requests
       (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status, idempotency_key, currency)
     values ($1, $2, $3, '5.00', '0.10', '4.90', 'momo_mtn', $4, 'pending', $5, 'GHS')`,
    [rejRef, userId, walletId, JSON.stringify({ account: phone, network: "MTN", method: "momo_mtn" }), `ks-key-${stamp}-r`],
  );
  track.withdrawalRefs.push(rejRef);
  const rejId = Number((await pool.query("select id from withdrawal_requests where ref = $1", [rejRef])).rows[0].id);
  const balDeducted = await balanceOf();
  check("reject fixture deducted (45.00)", balDeducted === 45, String(balDeducted));
  const rj = await adminAction(rejId, "reject", "kill-switch probe: reconciliation intact");
  check("reject still succeeds while disabled", rj.status === 200 && rj.body.status === "rejected", `status ${rj.status}`);
  check("reject still refunds exactly (45 → 50)", (await balanceOf()) === 50, String(await balanceOf()));
  const rejLedger = (await pool.query("select status::text as s from transactions where ref = $1", [rejRef])).rows[0].s;
  check("reject still flips the ledger row", rejLedger === "failed");
}

// ===========================================================================
// main
// ===========================================================================

async function main(): Promise<void> {
  await phaseA();

  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  const baseUrl = (process.env.BASE_URL?.trim() ?? "").replace(/\/$/, "");

  if (baseUrl && process.env.ALLOW_PRODUCTION !== "1" && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl)) {
    console.log(
      `\nRefusing to run: BASE_URL (${baseUrl}) does not look like a local test server (127.0.0.1 / localhost).\n` +
        "This script creates and deletes database rows; pass ALLOW_PRODUCTION=1 to force it.",
    );
    process.exit(2);
  }
  if (!databaseUrl || !baseUrl) {
    note("Phase B skipped", "set DATABASE_URL + BASE_URL (withdrawals-DISABLED app server) to drive the real API end to end");
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    const track: Track = { userEmails: [], withdrawalRefs: [], depositRefs: [] };
    const protectedBefore = await protectedSnapshot(pool).catch(() => "unavailable");
    try {
      await phaseB(baseUrl, pool, track);
    } finally {
      await cleanup(pool, track).catch((e) => note("cleanup warning", (e as Error)?.message ?? String(e)));
      const residue = await pool
        .query(
          "select (select count(*)::int from users where email like $1) as users, (select count(*)::int from withdrawal_requests where ref like 'WDL-KS-%') as wds",
          [`${PREFIX}%`],
        )
        .catch(() => null);
      if (residue) {
        check(
          "no suite residue left behind",
          (residue.rows[0]?.users as number) === 0 && (residue.rows[0]?.wds as number) === 0,
          JSON.stringify(residue.rows[0]),
        );
      }
      const protectedAfter = await protectedSnapshot(pool).catch(() => "unavailable");
      check("genuine deposit DP-MTMZN2P8SSBR byte-identical", protectedAfter === protectedBefore, protectedBefore === "absent" ? "absent in this DB (both)" : "compared");
      await pool.end().catch(() => undefined);
    }
  }

  console.log(`\n${checks} checks, ${failures} failures\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("suite crashed:", e);
  process.exit(1);
});
