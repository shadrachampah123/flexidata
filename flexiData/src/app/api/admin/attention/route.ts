import { requireAdminApi } from "@/lib/admin/auth";
import { loadAttention, type AdminAttentionSource } from "@/lib/admin/queries-operations";
import { adminError, adminJson, pageParam, pageSizeParam, searchParamsOf, strParam } from "@/lib/admin/api";

/**
 * `GET /api/admin/attention` — the queue of orders that need a human.
 *
 * Includes the orders `src/lib/checkout.ts` parks as `fulfillment_failed`
 * ("Support will fulfil or refund this order"), wallet orders that were charged
 * but never delivered, and Paystack deposits parked by the verification
 * mismatch guard. This handler itself remains read-only: it only reads.
 * Since Phase 2 Step 2 each checkout row also carries its recorded support
 * state (`supportAction` / `supportAt` / `supportAdminName`, derived from
 * `admin_audit_logs`) and an `actionable` flag; the writes themselves go
 * through `POST /api/admin/orders/[ref]/support`, which re-runs the admin gate
 * and never moves money.
 */
export const dynamic = "force-dynamic";

const SOURCES = ["checkout", "wallet", "deposit"] as const;

export async function GET(request: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  try {
    const params = searchParamsOf(request);
    const requested = strParam(params, "source", 10);
    const source = SOURCES.includes(requested as (typeof SOURCES)[number])
      ? (requested as AdminAttentionSource)
      : null;

    const result = await loadAttention({
      source,
      search: strParam(params, "search") ?? undefined,
      page: pageParam(params),
      pageSize: pageSizeParam(params),
    });
    return adminJson({ ok: true, ...result });
  } catch (error) {
    return adminError("attention queue", error);
  }
}
