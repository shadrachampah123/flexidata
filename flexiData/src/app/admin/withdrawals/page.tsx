import { requireAdmin } from "@/lib/admin/auth";
import { AdminPageHead } from "@/components/admin/page-head";
import { db } from "@/db";
import { withdrawalRequests, users, wallets } from "@/db/schema";
import { eq, desc, and, or, sql, like } from "drizzle-orm";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";
import { WithdrawalsExplorer } from "@/components/admin/withdrawals-explorer";

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

      <WithdrawalsExplorer
        initialRows={results}
        initialTotal={Number(count)}
        initialPage={page}
        pageSize={pageSize}
        initialFilters={{ status: status || "", search: search || "" }}
      />
    </div>
  );
}
