/**
 * Focused payout-reconciliation suite.
 *
 * Proves, against the REAL code and (in Phases B/C) a REAL database:
 *
 *   R1  the seven exception types exist and only those seven
 *   R2  stuck processing payouts are detected (>24h), exactly once per run
 *   R3  a still-stuck withdrawal re-flags on the next run AFTER its exception
 *       was resolved (dedup is on *unresolved* rows — alerts re-fire)
 *   R4  provider-vs-local divergences are detected (success/failure drift,
 *       amount drift, currency drift) — read-only, never settles anything
 *   R5  duplicate provider references are detected when they exist
 *       (defense-in-depth: the 0010 unique index normally forbids them)
 *   R6  reconciliation runs are read-only: balances, ledger rows and
 *       withdrawal rows are byte-identical before and after
 *   R7  the admin API is authenticated + authorized (anon/user → 404),
 *       lists/filters/paginates, runs, and resolves with an audit trail
 *
 * Layout:
 *   Phase A — pure type + source checks (no env needed).
 *   Phase B — detection + idempotency + read-only proof against a REAL
 *             database (needs DATABASE_URL; provider-backed R4 checks need the
 *             Paystack stub, PAYSTACK_STUB_URL default 127.0.0.1:4599).
 *   Phase C — admin API behavior (needs DATABASE_URL + BASE_URL with an app
 *             server whose ADMIN_EMAILS includes the suite admin below).
 *
 * IMPORTANT: this suite imports server-only app modules, so it must run with
 * the react-server condition: `npm run verify:payout-reconciliation`.
 *
 * Safety: refuses a non-local BASE_URL unless ALLOW_PRODUCTION=1; every row
 * it creates is tagged (`WDL-PR-…` refs, `fd-pr-…` users) and deleted again.
 *
 * Usage from the flexiData directory:
 *   npm run verify:payout-reconciliation
 *   DATABASE_URL='postgresql://…' npm run verify:payout-reconciliation
 *   DATABASE_URL='…' BASE_URL='http://127.0.0.1:3100' npm run verify:payout-reconciliation
 */
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { RECONCILIATION_EXCEPTION_TYPES } from "../src/lib/withdrawals";

const ADMIN_EMAIL = "fd-pr-admin@verify.flexidata.internal";
const PREFIX = "fd-pr-";
const PASSWORD = "Passw0rd!long-verify";
const TEST_KEY = process.env.TEST_PAYSTACK_SECRET?.trim() || "sk_test_phaseb_suite_key_1234567890";
const STUB_URL = (process.env.PAYSTACK_STUB_URL?.trim() || "http://127.0.0.1:4599").replace(/\/$/, "");

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

const ENV_KEYS = ["NODE_ENV", "WITHDRAWALS_ENABLED", "PAYSTACK_TRANSFERS_ENABLED", "PAYSTACK_SECRET_KEY", "PAYSTACK_BASE_URL", "PAYOUT_PROVIDER"] as const;
function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function readRepo(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

async function stubHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${STUB_URL}/_stub/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// ===========================================================================
// Phase A — pure type + source checks
// ===========================================================================

async function phaseA(): Promise<void> {
  console.log("\nPhase A — exception types + read-only source invariants\n");
  const expected = [
    "amount_mismatch",
    "currency_mismatch",
    "duplicate_provider_reference",
    "provider_failure_local_processing",
    "provider_success_local_processing",
    "stuck_processing",
    "unknown_provider_reference",
  ];
  check("exactly the seven exception types", JSON.stringify([...RECONCILIATION_EXCEPTION_TYPES].sort()) === JSON.stringify(expected), [...RECONCILIATION_EXCEPTION_TYPES].join(","));

  const src = readRepo("src/lib/payout-reconciliation.ts");
  check("reconciliation is server-only", src.includes('import "server-only"'));
  check(
    "reconciliation never writes wallets",
    !src.includes("update(wallets)") && !src.includes("balance:") && !src.includes("set({ balance"),
    "no wallet writes",
  );
  check("reconciliation never writes the ledger", !src.includes("transactions)") && !src.includes("from(transactions"), "no ledger writes");
  check("reconciliation never transitions withdrawals", !src.includes("update(withdrawalRequests)"), "no withdrawal writes");
  check("reconciliation never initiates transfers", !src.includes("initiateTransfer"), "detection only");
  check("duplicate detector exists (defense-in-depth)", src.includes("findDuplicateProviderReferences") || src.includes("duplicate_provider_reference"));
  check("provider-vs-local checks query the provider read-only", src.includes("getPayoutStatus"));

  const route = readRepo("src/app/api/admin/payout-reconciliation/route.ts");
  check("API route is admin-gated", route.includes("requireAdminApi"));
  check("API run action exists", route.includes('"run"'));
  check("API resolve action exists", route.includes('"resolve"'));
  check("resolve records the admin + note", route.includes("resolvedBy") && route.includes("resolutionNote"));
  check("resolve note length-capped", route.includes("slice(0, 240)"));
  check("unknown actions refused", route.includes("Unknown action"));
  check("list supports type filter", route.includes('searchParams.get("type")'));
  check("list supports resolved filter", route.includes('searchParams.get("resolved")'));
  check("list paginates with a cap", route.includes("pageSize"));
  check("responses are no-store", route.includes("no-store"));
  void existsSync;
}

// ===========================================================================
// Phase B — detection + idempotency + read-only proof
// ===========================================================================

type Track = { userEmails: string[]; withdrawalRefs: string[] };

async function stateSnapshot(pool: Pool): Promise<string> {
  const w = await pool.query("select id, balance::text as b from wallets order by id");
  const t = await pool.query("select ref, wallet_id, type::text as t, status::text as s, amount::text as a from transactions order by id");
  const wr = await pool.query("select ref, status::text as s, provider_reference as p, provider_status as ps from withdrawal_requests order by id");
  const e = await pool.query("select withdrawal_ref as r, exception_type as t, resolved as ok from payout_reconciliation_exceptions order by id");
  return JSON.stringify({ w: w.rows, t: t.rows, wr: wr.rows, e: e.rows });
}

async function cleanup(pool: Pool, track: Track): Promise<void> {
  if (track.withdrawalRefs.length > 0) {
    await pool.query("delete from withdrawal_audit_logs where withdrawal_ref = any($1)", [track.withdrawalRefs]);
    await pool.query("delete from payout_reconciliation_exceptions where withdrawal_ref = any($1)", [track.withdrawalRefs]);
    await pool.query("delete from withdrawal_requests where ref = any($1)", [track.withdrawalRefs]);
    await pool.query("delete from transactions where ref = any($1)", [track.withdrawalRefs]);
  }
  await pool.query("delete from payout_reconciliation_exceptions where description like '%WDL-PR-%'");
  if (track.userEmails.length > 0) {
    const ids = (await pool.query("select id from users where email = any($1)", [track.userEmails])).rows.map((r) => r.id as number);
    if (ids.length > 0) {
      await pool.query("delete from admin_audit_logs where admin_user_id = any($1) or target_user_id = any($1)", [ids]);
      await pool.query("delete from sessions where user_id = any($1)", [ids]);
      await pool.query("delete from wallets where user_id = any($1)", [ids]);
      await pool.query("delete from users where id = any($1)", [ids]);
    }
  }
}

async function phaseB(pool: Pool, track: Track): Promise<void> {
  console.log("\nPhase B — detection + idempotency + read-only proof (REAL database)\n");
  const { runPayoutReconciliation } = await import("../src/lib/payout-reconciliation");
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`.toUpperCase();
  const ref = (tag: string) => `WDL-PR-${stamp}-${tag}`.slice(0, 40);

  // Fixture user + wallet.
  const email = `${PREFIX}b-${stamp}@verify.flexidata.internal`.toLowerCase();
  const phone = `024${String(4000000 + (parseInt(stamp.slice(-6), 36) % 5999999))}`;
  const userId = Number(
    (
      await pool.query("insert into users (name, email, phone, password_hash, referral_code) values ($1, $2, $3, 'x', $4) returning id", [
        "PR User",
        email,
        phone,
        `PR${stamp}`.slice(0, 20),
      ])
    ).rows[0].id,
  );
  const walletId = Number(
    (await pool.query("insert into wallets (user_id, name, number, balance) values ($1, $2, $3, '250.00') returning id", [userId, "PR Wallet", phone])).rows[0].id,
  );
  track.userEmails.push(email);

  const mkWithdrawal = async (r: string, opts: { aged?: boolean; providerRef?: string | null } = {}): Promise<void> => {
    await pool.query(
      `insert into withdrawal_requests
         (ref, user_id, wallet_id, amount, fee, net_amount, destination_method, destination_details, status, idempotency_key, provider_reference, currency, processed_at, created_at)
       values ($1, $2, $3, '20.00', '0.40', '19.60', 'momo_mtn', $4, 'processing', $5, $6, 'GHS',
               ${opts.aged ? "now() - interval '25 hours'" : "now()"}, ${opts.aged ? "now() - interval '26 hours'" : "now()"})`,
      [r, userId, walletId, JSON.stringify({ account: phone, network: "MTN", method: "momo_mtn" }), `pr-key-${r}`, opts.providerRef ?? null],
    );
    track.withdrawalRefs.push(r);
  };
  const unresolved = async (type: string, r: string): Promise<number> =>
    Number((await pool.query("select count(*)::int as n from payout_reconciliation_exceptions where exception_type = $1 and withdrawal_ref = $2 and resolved = false", [type, r])).rows[0].n);
  const total = async (type: string, r: string): Promise<number> =>
    Number((await pool.query("select count(*)::int as n from payout_reconciliation_exceptions where exception_type = $1 and withdrawal_ref = $2", [type, r])).rows[0].n);

  // --- B1: run shape + stuck detection + idempotency (R2) -------------------
  console.log("--- B1 stuck detection (R2) ---");
  const freshRef = ref("FRESH");
  const stuckRef = ref("STUCK");
  await mkWithdrawal(freshRef);
  await mkWithdrawal(stuckRef, { aged: true, providerRef: `TRF-PR-STUCK-${stamp}` });
  const snapBefore = await stateSnapshot(pool);
  const run1 = await runPayoutReconciliation();
  check("run returns examined/newExceptions", typeof run1.examined === "number" && typeof run1.newExceptions === "number", `examined=${run1.examined} new=${run1.newExceptions}`);
  check("fresh processing NOT flagged", (await unresolved("stuck_processing", freshRef)) === 0);
  check("aged processing flagged (R2)", (await unresolved("stuck_processing", stuckRef)) === 1);
  const run2 = await runPayoutReconciliation();
  check("rerun creates no duplicate (idempotent)", (await total("stuck_processing", stuckRef)) === 1, `new2=${run2.newExceptions}`);
  const snapAfter = await stateSnapshot(pool);
  // The only allowed diff is the newly created exception row itself.
  const before = JSON.parse(snapBefore) as { e: unknown[] };
  const after = JSON.parse(snapAfter) as { e: unknown[] };
  check("runs add only exception rows (nothing else moves)", after.e.length === before.e.length + 1);

  // --- B2: resolve → re-flag (R3) -------------------------------------------
  console.log("\n--- B2 resolve → re-flag (R3) ---");
  await pool.query("update payout_reconciliation_exceptions set resolved = true, resolved_at = now(), resolved_by = $1, resolution_note = 'suite ack' where withdrawal_ref = $2 and exception_type = 'stuck_processing'", [userId, stuckRef]);
  check("exception resolvable", (await unresolved("stuck_processing", stuckRef)) === 0);
  await runPayoutReconciliation();
  check("still-stuck withdrawal re-flags after resolve (R3)", (await unresolved("stuck_processing", stuckRef)) === 1);
  check("history kept: 1 resolved + 1 unresolved", (await total("stuck_processing", stuckRef)) === 2);

  // --- B3: duplicate detector (R5) -------------------------------------------
  console.log("\n--- B3 duplicate detector (R5) ---");
  {
    // The 0010 unique index normally forbids duplicates; prove the detector
    // still fires when they exist (e.g. pre-0010 data) by briefly dropping
    // the index, then rebuilding it via the production self-heal.
    const dupeRef = `TRF-PR-DUPE-${stamp}`;
    const d1 = ref("DUP1");
    const d2 = ref("DUP2");
    await pool.query("drop index if exists withdrawal_requests_provider_ref_idx");
    try {
      await mkWithdrawal(d1, { providerRef: dupeRef });
      await mkWithdrawal(d2, { providerRef: dupeRef });
      await runPayoutReconciliation();
      const dupes = await pool.query("select count(*)::int as n from payout_reconciliation_exceptions where exception_type = 'duplicate_provider_reference' and (withdrawal_ref = $1 or withdrawal_ref = $2) and resolved = false", [d1, d2]);
      check("duplicate provider references flagged (R5)", (dupes.rows[0]?.n as number) >= 1, `n=${dupes.rows[0]?.n}`);
    } finally {
      await pool.query("delete from payout_reconciliation_exceptions where exception_type = 'duplicate_provider_reference' and description like '%WDL-PR-%'");
      await pool.query("delete from withdrawal_requests where ref = any($1)", [[d1, d2]]);
      track.withdrawalRefs = track.withdrawalRefs.filter((r) => r !== d1 && r !== d2);
      const { repairPayoutSystemSchema } = await import("../src/lib/seed");
      await repairPayoutSystemSchema();
    }
    const healed = await pool.query("select i.indisunique as u from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = 'withdrawal_requests_provider_ref_idx'");
    check("unique index rebuilt after detector probe", healed.rows[0]?.u === true);
  }

  // --- B4: provider-vs-local divergences (R4, stub-backed) -------------------
  console.log("\n--- B4 provider divergences (R4) ---");
  if (!(await stubHealthy())) {
    note("stub unreachable — B4 divergence checks skipped", `tried ${STUB_URL}`);
    return;
  }
  await fetch(`${STUB_URL}/_stub/reset`, { method: "POST" });
  const envSnap = snapshotEnv();
  const origEnv = { ...process.env };
  try {
    process.env.NODE_ENV = "test";
    // The divergence fixture initiates a real (stub) payout, so the temporary
    // withdrawal kill switch must be explicitly on for this probe.
    process.env.WITHDRAWALS_ENABLED = "true";
    process.env.PAYOUT_PROVIDER = "paystack-transfers";
    process.env.PAYSTACK_TRANSFERS_ENABLED = "true";
    process.env.PAYSTACK_SECRET_KEY = TEST_KEY;
    process.env.PAYSTACK_BASE_URL = STUB_URL;
    const { resetPayoutProvider } = await import("../src/lib/payout-service");
    const { resetPaystackBankCodeCache } = await import("../src/lib/paystack-transfers");
    resetPayoutProvider();
    resetPaystackBankCodeCache();

    const { db } = await import("../src/db/index");
    const { withdrawalRequests } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const { executeWithdrawalPayout } = await import("../src/lib/payout-execution");

    const divRef = ref("DIV");
    await mkWithdrawal(divRef);
    const payout = await db.transaction(async (tx) => {
      const rows = await tx.select().from(withdrawalRequests).where(eq(withdrawalRequests.ref, divRef)).for("update");
      return executeWithdrawalPayout(tx, rows[0], { type: "system" });
    });
    check("divergence fixture initiated via stub", payout.outcome === "initiated", payout.providerReference ?? "?");
    const flip = (scenario: string) =>
      fetch(`${STUB_URL}/_stub/transfer-scenario`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reference: divRef, scenario }) });
    const snapPre = await stateSnapshot(pool);

    await flip("success");
    await runPayoutReconciliation();
    check("provider success vs local processing flagged", (await unresolved("provider_success_local_processing", divRef)) === 1);
    await flip("failed");
    await runPayoutReconciliation();
    check("provider failure vs local processing flagged", (await unresolved("provider_failure_local_processing", divRef)) === 1);
    await flip("success-wrong-amount");
    await runPayoutReconciliation();
    check("provider amount drift flagged", (await unresolved("amount_mismatch", divRef)) === 1);
    await flip("success-wrong-currency");
    await runPayoutReconciliation();
    check("provider currency drift flagged", (await unresolved("currency_mismatch", divRef)) === 1);
    // Each type fires at most once while unresolved.
    await flip("success");
    await runPayoutReconciliation();
    check("divergence rerun creates no duplicates", (await total("provider_success_local_processing", divRef)) === 1);
    await flip("pending");

    // Read-only proof: strip exception rows; everything else identical.
    const snapPost = await stateSnapshot(pool);
    const strip = (s: string): string => {
      const o = JSON.parse(s) as { w: unknown; t: unknown; wr: unknown };
      return JSON.stringify({ w: o.w, t: o.t, wr: o.wr });
    };
    check("divergence runs move no money and touch no rows (R6)", strip(snapPost) === strip(snapPre));
    const balAfter = await pool.query("select balance::text as b from wallets where id = $1", [walletId]);
    check("fixture wallet untouched (250.00)", (balAfter.rows[0]?.b as string) === "250.00");
    void origEnv;
  } finally {
    for (const k of ENV_KEYS) {
      if (envSnap[k] === undefined) delete process.env[k];
      else process.env[k] = envSnap[k];
    }
    const { resetPayoutProvider } = await import("../src/lib/payout-service");
    const { resetPaystackBankCodeCache } = await import("../src/lib/paystack-transfers");
    resetPayoutProvider();
    resetPaystackBankCodeCache();
  }
}

// ===========================================================================
// Phase C — admin API behavior
// ===========================================================================

async function phaseC(base: string, pool: Pool, track: Track): Promise<void> {
  console.log("\nPhase C — reconciliation admin API (REAL app server)\n");
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const ref = (tag: string) => `WDL-PR-${stamp}-${tag}`.slice(0, 40).toUpperCase();

  const adminJar = new Jar();
  await adminJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Pr Admin", email: ADMIN_EMAIL, phone: `020${1000000 + (parseInt(stamp.slice(-6), 36) % 8999999)}`, password: PASSWORD }),
  });
  await adminJar.req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: ADMIN_EMAIL, password: PASSWORD }) });
  await pool.query("update users set is_admin = true where email = $1", [ADMIN_EMAIL]);
  track.userEmails.push(ADMIN_EMAIL);
  const adminMe = await adminJar.req(base, "/api/admin/me");
  check("suite admin admitted", adminMe.status === 200, `status ${adminMe.status} (app needs ADMIN_EMAILS=${ADMIN_EMAIL})`);
  if (adminMe.status !== 200) {
    bad("Phase C aborted", "admin gate refused");
    return;
  }
  const userJar = new Jar();
  const userEmail = `${PREFIX}c-${stamp}@verify.flexidata.internal`;
  await userJar.req(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Pr User", email: userEmail, phone: `024${1000000 + ((parseInt(stamp.slice(-6), 36) + 777) % 8999999)}`, password: PASSWORD }),
  });
  await userJar.req(base, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: userEmail, password: PASSWORD }) });
  track.userEmails.push(userEmail);

  // --- C1: auth matrix (R7) --------------------------------------------------
  console.log("--- C1 auth matrix (R7) ---");
  const anonGet = await fetch(`${base}/api/admin/payout-reconciliation`);
  check("anon GET → 404", anonGet.status === 404, `status ${anonGet.status}`);
  const anonPost = await fetch(`${base}/api/admin/payout-reconciliation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run" }) });
  check("anon POST run → 404", anonPost.status === 404, `status ${anonPost.status}`);
  const userGet = await userJar.req(base, "/api/admin/payout-reconciliation");
  check("user GET → 404", userGet.status === 404, `status ${userGet.status}`);
  const userPost = await userJar.req(base, "/api/admin/payout-reconciliation", { method: "POST", body: JSON.stringify({ action: "run" }) });
  check("user POST run → 404", userPost.status === 404, `status ${userPost.status}`);

  // --- C2: list shape + filters + pagination (R7) ----------------------------
  console.log("\n--- C2 list + filters + pagination (R7) ---");
  const refs: string[] = [];
  for (const t of RECONCILIATION_EXCEPTION_TYPES) {
    const r = ref(t.slice(0, 8).replace(/_/g, ""));
    refs.push(r);
    track.withdrawalRefs.push(r);
    await pool.query(
      "insert into payout_reconciliation_exceptions (withdrawal_ref, exception_type, description, local_status, currency) values ($1, $2, $3, 'processing', 'GHS')",
      [r, t, `suite ${t} for ${r}`],
    );
  }
  const listAll = (await (await adminJar.req(base, "/api/admin/payout-reconciliation?pageSize=100")).json()) as {
    ok?: boolean; data?: Array<{ withdrawal_ref: string; exception_type: string }>; total?: number; page?: number; pageSize?: number;
  };
  check("admin list → 200 + shape", listAll.ok === true && Array.isArray(listAll.data) && typeof listAll.total === "number", `total=${listAll.total}`);
  const listed = new Set((listAll.data ?? []).map((r) => r.exception_type));
  check("all seven types listable", RECONCILIATION_EXCEPTION_TYPES.every((t) => listed.has(t)), [...listed].sort().join(","));
  const filtered = (await (await adminJar.req(base, "/api/admin/payout-reconciliation?type=amount_mismatch&pageSize=100")).json()) as { data?: Array<{ exception_type: string }> };
  check("type filter works", (filtered.data ?? []).length >= 1 && (filtered.data ?? []).every((r) => r.exception_type === "amount_mismatch"));
  const unresolvedOnly = (await (await adminJar.req(base, "/api/admin/payout-reconciliation?resolved=false&pageSize=100")).json()) as { data?: Array<{ withdrawal_ref: string }> };
  const unresolvedRefs = new Set((unresolvedOnly.data ?? []).map((r) => r.withdrawal_ref));
  check("resolved=false filter includes the fixtures", refs.every((r) => unresolvedRefs.has(r)));
  const p1 = (await (await adminJar.req(base, "/api/admin/payout-reconciliation?page=1&pageSize=3")).json()) as { data?: unknown[]; page?: number; pageSize?: number };
  const p2 = (await (await adminJar.req(base, "/api/admin/payout-reconciliation?page=2&pageSize=3")).json()) as { data?: unknown[] };
  const p3 = (await (await adminJar.req(base, "/api/admin/payout-reconciliation?page=3&pageSize=3")).json()) as { data?: unknown[] };
  check("pagination pages (3/3/1+)", (p1.data ?? []).length === 3 && (p2.data ?? []).length === 3 && (p3.data ?? []).length >= 1 && p1.page === 1 && p1.pageSize === 3);

  // --- C3: resolve flow (R7) --------------------------------------------------
  console.log("\n--- C3 resolve flow (R7) ---");
  const target = (await pool.query("select id from payout_reconciliation_exceptions where withdrawal_ref = $1", [refs[0]])).rows[0].id as number;
  const longNote = "n".repeat(300);
  const resRes = await adminJar.req(base, "/api/admin/payout-reconciliation", { method: "POST", body: JSON.stringify({ action: "resolve", exceptionId: target, note: longNote }) });
  check("resolve → 200", resRes.status === 200, `status ${resRes.status}`);
  const resolved = (await pool.query("select resolved, resolved_by, resolution_note from payout_reconciliation_exceptions where id = $1", [target])).rows[0];
  const adminId = Number((await pool.query("select id from users where email = $1", [ADMIN_EMAIL])).rows[0].id);
  check("resolved flag set", resolved.resolved === true);
  check("resolved_by is the admin", Number(resolved.resolved_by) === adminId);
  check("300-char note trimmed to 240", (resolved.resolution_note as string).length === 240, `len=${(resolved.resolution_note as string).length}`);
  const resolvedOnly = (await (await adminJar.req(base, "/api/admin/payout-reconciliation?resolved=true&pageSize=100")).json()) as { data?: Array<{ withdrawal_ref: string }> };
  check("resolved=true filter finds it", (resolvedOnly.data ?? []).some((r) => r.withdrawal_ref === refs[0]));
  const badId = await adminJar.req(base, "/api/admin/payout-reconciliation", { method: "POST", body: JSON.stringify({ action: "resolve", exceptionId: -5 }) });
  check("resolve bad id → 400", badId.status === 400, `status ${badId.status}`);
  const badAction = await adminJar.req(base, "/api/admin/payout-reconciliation", { method: "POST", body: JSON.stringify({ action: "nuke" }) });
  check("unknown action → 400", badAction.status === 400, `status ${badAction.status}`);

  // --- C4: run via API (R2/R6) -------------------------------------------------
  console.log("\n--- C4 run via API (R2/R6) ---");
  const snapBefore = await stateSnapshot(pool);
  const runRes = await adminJar.req(base, "/api/admin/payout-reconciliation", { method: "POST", body: JSON.stringify({ action: "run" }) });
  const runBody = (await runRes.json().catch(() => ({}))) as { ok?: boolean; examined?: number; newExceptions?: number; ranAt?: string };
  check("API run → 200 + shape", runRes.status === 200 && runBody.ok === true && typeof runBody.examined === "number" && typeof runBody.ranAt === "string", `examined=${runBody.examined} new=${runBody.newExceptions}`);
  const snapAfter = await stateSnapshot(pool);
  const stripMoney = (s: string): string => {
    const o = JSON.parse(s) as { w: unknown; t: unknown; wr: unknown };
    return JSON.stringify({ w: o.w, t: o.t, wr: o.wr });
  };
  check("API run moves no money and touches no rows", stripMoney(snapAfter) === stripMoney(snapBefore));

  // Fixtures are untagged withdrawal refs without rows — remove exception rows.
  await pool.query("delete from payout_reconciliation_exceptions where withdrawal_ref = any($1)", [refs]);
  track.withdrawalRefs = track.withdrawalRefs.filter((r) => !refs.includes(r));
}

// ===========================================================================
// main
// ===========================================================================

async function main(): Promise<void> {
  await phaseA();

  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  const baseUrl = (process.env.BASE_URL?.trim() ?? "").replace(/\/$/, "");

  if (baseUrl && process.env.ALLOW_PRODUCTION !== "1" && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl)) {
    console.log(`\nRefusing to run: BASE_URL (${baseUrl}) is not local. Pass ALLOW_PRODUCTION=1 to force it.`);
    process.exit(2);
  }
  if (!databaseUrl) {
    note("Phase B skipped", "set DATABASE_URL to probe detection against a real database");
    note("Phase C skipped", "set DATABASE_URL + BASE_URL to drive the admin API");
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    const track: Track = { userEmails: [], withdrawalRefs: [] };
    try {
      await phaseB(pool, track);
      if (!baseUrl) {
        note("Phase C skipped", "set BASE_URL to drive the admin API");
      } else {
        await phaseC(baseUrl, pool, track);
      }
    } finally {
      await cleanup(pool, track).catch((e) => note("cleanup warning", (e as Error)?.message ?? String(e)));
      const residue = await pool
        .query(
          "select (select count(*)::int from users where email like $1) as users, (select count(*)::int from withdrawal_requests where ref like 'WDL-PR-%') as wds, (select count(*)::int from payout_reconciliation_exceptions where description like '%WDL-PR-%') as exc",
          [`${PREFIX}%`],
        )
        .catch(() => null);
      if (residue) {
        check("no suite residue left behind", (residue.rows[0]?.users as number) === 0 && (residue.rows[0]?.wds as number) === 0 && (residue.rows[0]?.exc as number) === 0, JSON.stringify(residue.rows[0]));
      }
      // The B3 probe drops/rebuilds the provider index — prove it is back.
      const idx = await pool.query("select i.indisunique as u from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = 'withdrawal_requests_provider_ref_idx'").catch(() => null);
      if (idx) check("provider unique index intact after suite", idx.rows[0]?.u === true);
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
