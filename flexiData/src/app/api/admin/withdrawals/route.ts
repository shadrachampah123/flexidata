import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin/auth";
import { db } from "@/db";
import { withdrawalRequests, users, wallets, withdrawalAuditLogs } from "@/db/schema";
import { eq, desc, and, or, like, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/**
 * GET /api/admin/withdrawals
 *
 * Server-side listing of withdrawal requests with filtering:
 *   - status (pending, processing, successful, rejected, refunded)
 *   - search (by ref, email, wallet number, destination)
 *   - method (momo_mtn, telecel_cash)
 *   - dateFrom / dateTo (ISO date strings)
 *   - page / pageSize (pagination)
 *
 * Returns paginated results with total count.
 */
export async function GET(req: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const status = url.searchParams.get("status") || "";
  const search = url.searchParams.get("search") || "";
  const method = url.searchParams.get("method") || "";
  const dateFrom = url.searchParams.get("dateFrom") || "";
  const dateTo = url.searchParams.get("dateTo") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "25", 10)));

  const conditions = [];

  if (status) {
    conditions.push(eq(withdrawalRequests.status, status as "pending" | "processing" | "successful" | "failed" | "rejected" | "cancelled" | "refunded"));
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

  if (dateFrom) {
    conditions.push(sql`${withdrawalRequests.createdAt} >= ${dateFrom}::timestamptz`);
  }
  if (dateTo) {
    conditions.push(sql`${withdrawalRequests.createdAt} <= ${dateTo}::timestamptz`);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (page - 1) * pageSize;

  const [results, countResult] = await Promise.all([
    db
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
        userId: users.id,
        userName: users.name,
        walletNumber: wallets.number,
        adminUserId: withdrawalRequests.adminUserId,
        rejectionReason: withdrawalRequests.adminRejectionReason,
        providerReference: withdrawalRequests.providerReference,
        providerStatus: withdrawalRequests.providerStatus,
        currency: withdrawalRequests.currency,
      })
      .from(withdrawalRequests)
      .leftJoin(users, eq(withdrawalRequests.userId, users.id))
      .leftJoin(wallets, eq(withdrawalRequests.walletId, wallets.id))
      .where(whereClause)
      .orderBy(desc(withdrawalRequests.createdAt))
      .limit(pageSize)
      .offset(offset),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(withdrawalRequests)
      .leftJoin(users, eq(withdrawalRequests.userId, users.id))
      .leftJoin(wallets, eq(withdrawalRequests.walletId, wallets.id))
      .where(whereClause),
  ]);

  return NextResponse.json(
    {
      ok: true,
      data: results,
      total: countResult[0]?.count ?? 0,
      page,
      pageSize,
    },
    { headers: NO_STORE },
  );
}
