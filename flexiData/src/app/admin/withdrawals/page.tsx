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

  // Read-only catalog probes (no DDL needed): surface schema drift that would
  // otherwise roll back every approve/reject on its audit INSERT (SQLSTATE
  // 23514) as a visible maintenance state BEFORE the operator clicks — the
  // action route answers the same drift with an explicit 503, but the point
  // is that nobody has to discover it by clicking Reject first.
  const [withdrawalSchema, adminAudit] = await Promise.all([
    describeWithdrawalCompatibility(),
    describeAdminAuditCompatibility(),
  ]);
  const actionsBlocked =
    adminAudit.status === "legacy" || adminAudit.status === "missing";

  // Without `withdrawal_requests` the select below would 500 the whole page;
  // show the maintenance answer instead (the schema self-heal in the write
  // path keeps trying to create the table additively).
  if (withdrawalSchema.status === "missing") {
    return (
      <div className="space-y-4">
        <AdminPageHead title="Withdrawals" subtitle="Manage user withdrawal requests." />
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-[13px] font-semibold text-amber-700 dark:text-amber-300">
          Withdrawals are unavailable: the <code>withdrawal_requests</code> table is missing from
          this database. Run <code>npx drizzle-kit push</code> against it (see
          drizzle/0005_lively_hiroim.sql).
        </div>
      </div>
    );
  }

  const conditions = [];
  if (status) {
    conditions.push(eq(withdrawalRequests.status, status as any));
  }
  if (search) {
    conditions.push(or(
      like(withdrawalRequests.ref, `%${search}%`),
      like(users.email, `%${search}%`),
      like(wallets.number, `%${search}%`)
    ));
  }

  const offset = (page - 1) * pageSize;

  const results = await db.select({
    id: withdrawalRequests.id,
    ref: withdrawalRequests.ref,
    amount: withdrawalRequests.amount,
    fee: withdrawalRequests.fee,
    netAmount: withdrawalRequests.netAmount,
    status: withdrawalRequests.status,
    createdAt: withdrawalRequests.createdAt,
    method: withdrawalRequests.destinationMethod,
    dest: sql`${withdrawalRequests.destinationDetails}->>'account'`,
    userEmail: users.email,
    walletNumber: wallets.number,
    adminUserId: withdrawalRequests.adminUserId,
    rejectionReason: withdrawalRequests.adminRejectionReason,
  })
  .from(withdrawalRequests)
  .leftJoin(users, eq(withdrawalRequests.userId, users.id))
  .leftJoin(wallets, eq(withdrawalRequests.walletId, wallets.id))
  .where(and(...conditions))
  .orderBy(desc(withdrawalRequests.createdAt))
  .limit(pageSize)
  .offset(offset);

  const [{ count }] = await db.select({ count: sql<number>`count(*)` })
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
          withdrawal actions, so every action would roll back without moving any money (SQLSTATE
          23514). An operator must apply drizzle/0007 against this database with the targeted,
          non-destructive migration — <code>npm run migrate:admin-audit-actions</code> (do NOT use
          <code>npx drizzle-kit push</code> here: it diffs the whole schema and would request
          DROPs of any production-only tables). No request below has been changed.
        </div>
      )}
      <WithdrawalsExplorer
        initialRows={results}
        initialTotal={Number(count)}
        initialPage={page}
        pageSize={pageSize}
        initialFilters={{ status: status || "", search: search || "" }}
        actionsBlocked={actionsBlocked}
      />
    </div>
  );
}
