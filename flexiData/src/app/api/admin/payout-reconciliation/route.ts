import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin/auth";
import { runPayoutReconciliation, fetchReconciliationExceptions } from "@/lib/payout-reconciliation";
import { db } from "@/db";
import { payoutReconciliationExceptions } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/**
 * GET /api/admin/payout-reconciliation
 *
 * Returns unresolved payout reconciliation exceptions for admin review.
 */
export async function GET(req: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const type = url.searchParams.get("type") || undefined;
  const resolved = url.searchParams.get("resolved");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "25", 10)));

  const result = await fetchReconciliationExceptions({
    type,
    resolved: resolved !== null ? resolved === "true" : undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return NextResponse.json(
    {
      ok: true,
      data: result.rows,
      total: result.total,
      page,
      pageSize,
    },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/admin/payout-reconciliation
 *
 * Body: { action: "run" | "resolve", exceptionId?: number, note?: string }
 *
 * "run" triggers a reconciliation scan.
 * "resolve" marks an exception as resolved.
 */
export async function POST(req: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const { admin } = gate.context;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";

  if (action === "run") {
    try {
      const result = await runPayoutReconciliation();
      return NextResponse.json(
        {
          ok: true,
          ranAt: result.ranAt.toISOString(),
          examined: result.examined,
          newExceptions: result.newExceptions,
          exceptions: result.exceptions,
        },
        { headers: NO_STORE },
      );
    } catch (err: unknown) {
      console.error("[flexidata] payout reconciliation failed", err);
      return NextResponse.json(
        { ok: false, error: "Reconciliation failed" },
        { status: 500, headers: NO_STORE },
      );
    }
  }

  if (action === "resolve") {
    const exceptionId = typeof body.exceptionId === "number" ? body.exceptionId : parseInt(String(body.exceptionId), 10);
    if (!Number.isInteger(exceptionId) || exceptionId <= 0) {
      return NextResponse.json({ ok: false, error: "Invalid exception id" }, { status: 400 });
    }
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 240) : "";

    await db
      .update(payoutReconciliationExceptions)
      .set({
        resolved: true,
        resolvedAt: new Date(),
        resolvedBy: admin.userId,
        resolutionNote: note || null,
      })
      .where(eq(payoutReconciliationExceptions.id, exceptionId));

    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
}
