import { requireAdmin } from "@/lib/admin/auth";
import { AdminPageHead } from "@/components/admin/page-head";
import { db } from "@/db";
import { withdrawalRequests, users, wallets } from "@/db/schema";
import { eq, desc, and, or, sql, like } from "drizzle-orm";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";
import { WithdrawalsExplorer } from "@/components/admin/withdrawals-explorer";
import {
  describeAdminAuditCompatibility,
  describeWithdrawalCompatibility,
} from "@/lib/schema-compat";
import { isWithdrawalsEnabled } from "@/lib/withdrawal-flag";

export const dynamic = "force-dynamic";
export const metadata = { title: "Withdrawals · FlexiData" };

export default async function AdminWithdrawalsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const { admin } = await requireAdmin();

  const params = await searchParams;
  const page = parsePage(q(params, "page"));
  const pageSize = parsePageSize(q(params, "pageSize"));
  const status = q(params, "status");
  const search = q(params, "search");
  const method = q(params, "method");

  // Read-only catalog probes
  const [withdrawalSchema, adminAudit] = await Promise.all([
    describeWithdrawalCompatibility(),
    describeAdminAuditCompatibility(),
  ]);
  const actionsBlocked =
    adminAudit.status === "legacy" || adminAudit.status === "missing";
  // Temporary withdrawal kill switch, resolved server-side (fail-closed: only
  // an explicit WITHDRAWALS_ENABLED=true enables). While off, approve and
  // retry are blocked at the API — the explorer disables those buttons so an
  // approval cannot be attempted by accident — while the records below stay
  // visible and reject/refund reconciliation keeps working.
  const withdrawalsDisabled = !isWithdrawalsEnabled();

  if (withdrawalSchema.status === "missing") {
    return (
      <div className="space-y-4">
        <AdminPageHead title="Withdrawals" subtitle="Manage user withdrawal requests." />
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-[13px] font-semibold text-amber-700 dark:text-amber-300">
          Withdrawals are unavailable: the <code>withdrawal_requests</code> table is missing from
          this database. Run <code>npx drizzle-kit push</code> against it.
        </div>
      </div>
    );
  }

  const conditions = [];
  if (status) {
    conditions.push(eq(withdrawalRequests.status, status as any));
  }
  if (method) {
    conditions.push(eq(withdrawalRequests.destinationMethod, method));
  }
  if (search) {
    conditions.push(
      or(
        like(withdrawalRequests.ref, `%${search}%`),
        like(users.email, `%${search}%`),
        like(wallets.number, `%${search}%`),
        like(sql`${withdrawalRequests.destinationDetails}->>'account'`, `%${search}%`),
      ),
    );
  }

  const offset = (page - 1) * pageSize;

  const results = await db
    .select({
      id: withdrawalRequests.id,
      ref: withdrawalRequests.ref,
      amount: withdrawalRequests.amount,
      fee: withdrawalRequests.fee,
      netAmount: withdrawalRequests.netAmount,
      status: withdrawalRequests.status,
      createdAt: withdrawalRequests.createdAt,
      processedAt: withdrawalRequests.processedAt,
      completedAt: withdrawalRequests.completedAt,
      method: withdrawalRequests.destinationMethod,
      dest: sql<string>`${withdrawalRequests.destinationDetails}->>'account'`,
      network: sql<string>`${withdrawalRequests.destinationDetails}->>'network'`,
      userEmail: users.email,
      walletNumber: wallets.number,
      adminUserId: withdrawalRequests.adminUserId,
      rejectionReason: withdrawalRequests.adminRejectionReason,
      providerReference: withdrawalRequests.providerReference,
      currency: withdrawalRequests.currency,
    })
    .from(withdrawalRequests)
    .leftJoin(users, eq(withdrawalRequests.userId, users.id))
    .leftJoin(wallets, eq(withdrawalRequests.walletId, wallets.id))
    .where(and(...conditions))
    .orderBy(desc(withdrawalRequests.createdAt))
    .limit(pageSize)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(withdrawalRequests)
    .leftJoin(users, eq(withdrawalRequests.userId, users.id))
    .leftJoin(wallets, eq(withdrawalRequests.walletId, wallets.id))
    .where(and(...conditions));

  return (
    <div className="space-y-4">
      <AdminPageHead
        title="Withdrawals"
        subtitle="Manage user withdrawal requests."
      />
      {actionsBlocked && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-[13px] font-semibold text-amber-700 dark:text-amber-300">
          Approve / reject is BLOCKED on this database: the admin audit trail still predates the
          withdrawal actions. No request below has been changed.
        </div>
      )}
      {withdrawalsDisabled && (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-[13px] font-semibold text-rose-700 dark:text-rose-300">
          Withdrawals and payouts are currently <strong>disabled</strong> (WITHDRAWALS_ENABLED is
          not true). New withdrawal requests are refused, and approve / retry are blocked by the
          API — the records below remain visible, and reject / refund reconciliation for
          historical records is still available. Re-enable only after Paystack Transfers /
          third-party payouts are approved, by setting WITHDRAWALS_ENABLED=true.
        </div>
      )}
      <WithdrawalsExplorer
        initialRows={results}
        initialTotal={Number(count)}
        initialPage={page}
        pageSize={pageSize}
        initialFilters={{ status: status || "", search: search || "", method: method || "" }}
        actionsBlocked={actionsBlocked}
        withdrawalsDisabled={withdrawalsDisabled}
      />
    </div>
  );
}
