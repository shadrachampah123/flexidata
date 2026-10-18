/**
 * DB-free safety checks for the safe portion of admin Phases 3–6.
 *
 * This is intentionally not a fake completion suite. It verifies implemented
 * behavior that does not need an owner-approved schema or permission policy:
 *
 *   - existing admin writes reject explicit cross-site requests after the
 *     existing two-signal admin gate;
 *   - all current `admin_audit_logs` writers use one typed, bounded value
 *     builder and the shipped action vocabulary;
 *   - the support delivery transition repeats its complete eligibility rule in
 *     the conditional SQL UPDATE, closing a read/update race;
 *   - the existing withdrawal kill switch remains fail-closed.
 *
 * It deliberately does NOT create or simulate `admin_roles`, support-case,
 * `wallet_adjustments`, or `system_controls` tables. Those features remain
 * inactive until the owner decisions recorded in
 * `docs/admin-ops-dashboard/08-phases-3-6-safe-progress.md` are approved.
 *
 * No DATABASE_URL is used by this suite and no provider/payment call is made.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
try {
  const resolved = require.resolve("server-only");
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {},
  } as unknown as NodeJS.Module;
} catch {
  // The package is present in the application install; keep this verifier
  // usable in a deliberately minimal DB-free environment too.
}

process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/placeholder";

const results: { name: string; ok: boolean; detail?: unknown }[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function repo(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
section("A. Request-boundary policy");
const { adminWriteRequestDecision } = await import("@/lib/admin/request-policy");

check(
  "missing browser headers remain compatible for same-origin operational callers",
  adminWriteRequestDecision(new Request("https://admin.example/api/admin/orders/CO-1/support")).ok,
);
check(
  "same-origin Origin is accepted",
  adminWriteRequestDecision(
    new Request("https://admin.example/api/admin/orders/CO-1/support", {
      headers: { origin: "https://admin.example" },
    }),
  ).ok,
);
check(
  "explicit Sec-Fetch-Site cross-site is rejected",
  adminWriteRequestDecision(
    new Request("https://admin.example/api/admin/orders/CO-1/support", {
      headers: { "sec-fetch-site": "cross-site" },
    }),
  ).ok === false,
);
check(
  "mismatched Origin is rejected",
  adminWriteRequestDecision(
    new Request("https://admin.example/api/admin/orders/CO-1/support", {
      headers: { origin: "https://evil.example" },
    }),
  ).ok === false,
);
check(
  "opaque Origin is rejected",
  adminWriteRequestDecision(
    new Request("https://admin.example/api/admin/orders/CO-1/support", {
      headers: { origin: "null" },
    }),
  ).ok === false,
);

section("B. Existing audit writer accountability");
const { ADMIN_AUDIT_ACTIONS, adminAuditValues } = await import("@/lib/admin/audit-writer");

check(
  "audit vocabulary is exactly the shipped database vocabulary",
  JSON.stringify(ADMIN_AUDIT_ACTIONS) ===
    JSON.stringify([
      "suspend",
      "activate",
      "delivery_resolved",
      "refund_review",
      "approve_withdrawal",
      "reject_withdrawal",
    ]),
  ADMIN_AUDIT_ACTIONS,
);
const audit = adminAuditValues({
  adminUserId: 7,
  targetUserId: 9,
  action: "refund_review",
  reason: `  ${"x".repeat(300)}  `,
  targetRef: " CO-FAIL-1 ",
});
check("audit actor and target ids are server-side positive integers", audit.adminUserId === 7 && audit.targetUserId === 9);
check("audit reason is trimmed and bounded to the existing column", audit.reason?.length === 240);
check("audit target reference is normalized", audit.targetRef === "CO-FAIL-1");
check("audit helper rejects a non-positive actor", throws(() => adminAuditValues({ adminUserId: 0, targetUserId: 9, action: "activate" })));
check("audit helper rejects an unsafe target reference", throws(() => adminAuditValues({ adminUserId: 7, targetUserId: 9, action: "activate", targetRef: "bad ref" })));

const auditWriters = [
  "src/lib/customer-management.ts",
  "src/lib/support-actions.ts",
  "src/app/api/admin/withdrawals/[id]/action/route.ts",
];
const auditSource = auditWriters.map(repo).join("\n");
const directAuditInsertCount = (auditSource.match(/insert\(adminAuditLogs\)\.values\(/g) ?? []).length;
const helperAuditInsertCount = (auditSource.match(/insert\(adminAuditLogs\)\.values\(\s*adminAuditValues\(/g) ?? []).length;
check("all current central audit inserts are accounted for", directAuditInsertCount === 6, { directAuditInsertCount });
check("all current central audit inserts use the typed value builder", helperAuditInsertCount === 6, { helperAuditInsertCount });
check("central audit writer adds no DB table or migration", !repo("src/lib/admin/audit-writer.ts").includes("CREATE TABLE") && !repo("src/lib/admin/audit-writer.ts").includes("wallet_adjustments"));

section("C. Support transition race safety");
const support = await import("@/lib/support-actions");
const now = Date.parse("2026-10-18T12:00:00.000Z");
check(
  "old captured paid orders are eligible",
  support.isSupportableOrder({ orderStatus: "paid", paymentStatus: "successful", updatedAt: new Date(now - support.SUPPORT_STUCK_AFTER_MS - 1) }, now),
);
check(
  "fresh captured paid orders are not eligible",
  !support.isSupportableOrder({ orderStatus: "paid", paymentStatus: "successful", updatedAt: new Date(now - support.SUPPORT_STUCK_AFTER_MS + 1) }, now),
);
check(
  "explicitly parked captured orders remain eligible",
  support.isSupportableOrder({ orderStatus: "fulfillment_failed", paymentStatus: "successful", updatedAt: new Date(now) }, now),
);
check(
  "unpaid orders are never eligible",
  !support.isSupportableOrder({ orderStatus: "fulfillment_failed", paymentStatus: "pending", updatedAt: new Date(now - support.SUPPORT_STUCK_AFTER_MS - 1) }, now),
);
const supportSource = repo("src/lib/support-actions.ts");
check("delivery update repeats the stuck-age predicate in SQL", supportSource.includes("lt(checkoutOrders.updatedAt, supportCutoff)"));
check("delivery update uses the repeated predicate instead of a broad status-only UPDATE", supportSource.includes("stillSupportable") && !supportSource.includes("inArray(checkoutOrders.orderStatus, [...SUPPORTABLE_ORDER_STATUSES])"));

section("D. Existing emergency control remains fail-closed");
const { isWithdrawalsEnabled } = await import("@/lib/withdrawal-flag");
const originalWithdrawalFlag = process.env.WITHDRAWALS_ENABLED;
try {
  delete process.env.WITHDRAWALS_ENABLED;
  check("missing withdrawal flag blocks money movement", isWithdrawalsEnabled() === false);
  process.env.WITHDRAWALS_ENABLED = "false";
  check("false withdrawal flag blocks money movement", isWithdrawalsEnabled() === false);
  process.env.WITHDRAWALS_ENABLED = "true";
  check("only explicit true re-arms the existing withdrawal control", isWithdrawalsEnabled() === true);
} finally {
  if (originalWithdrawalFlag === undefined) delete process.env.WITHDRAWALS_ENABLED;
  else process.env.WITHDRAWALS_ENABLED = originalWithdrawalFlag;
}
check("no unapproved system-control table is referenced by the existing control", !repo("src/lib/withdrawal-flag.ts").includes("system_controls"));

section("E. Phase 3–6 inactive boundaries");
const schema = repo("src/db/schema.ts");
const migrationNames = repo("drizzle/meta/_journal.json");
check("no unapproved RBAC/support-case/financial-adjustment/control schema was added", !/admin_roles|support_cases|support_case_notes|wallet_adjustments|system_controls/.test(schema));
check("the migration journal contains no unapproved Phase 3–6 table", !/admin_roles|support_cases|support_case_notes|wallet_adjustments|system_controls/.test(migrationNames));
check("roadmap records the exact pending owner decisions", repo("../docs/admin-ops-dashboard/08-phases-3-6-safe-progress.md").includes("Owner decisions still required"));

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`${failed.length} DB-free Phase 3–6 check(s) failed.`);
  process.exitCode = 1;
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
