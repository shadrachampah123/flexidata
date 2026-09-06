import { requireAdminApi } from "@/lib/admin/auth";
import {
  adminError,
  adminJson,
  dateFromParam,
  dateToParam,
  pageParam,
  pageSizeParam,
  searchParamsOf,
  strParam,
} from "@/lib/admin/api";
import { loadRefundReviews } from "@/lib/admin/queries-investigation";

/**
 * `GET /api/admin/reviews` — the refund-review backlog.
 *
 * Phase 2, Step 3 (S3.5). Step 2 gave administrators a way to RECORD that
 * finance should look at refunding an order, and disclosed the limitation that
 * nothing listed those records afterwards: a reviewed order simply stayed in the
 * attention queue. This endpoint derives the backlog from the audit trail, so
 * finance can see every open review, its age, and the total value waiting on a
 * decision.
 *
 * A review is OPEN when no `delivery_resolved` was recorded at or after it —
 * the same rule `hasOpenRefundReview()` in the pure diagnosis engine uses, so
 * the backlog and an individual order page cannot disagree.
 *
 * Read-only. It changes no order status and records nothing: closing a review
 * still means an administrator resolving the order through the Step 2 support
 * workflow, or finance settling it out-of-band. No money moves here, and there
 * is no refund execution anywhere in this endpoint's reach.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  try {
    const params = searchParamsOf(request);
    const result = await loadRefundReviews({
      state: strParam(params, "state", 10),
      search: strParam(params, "search") ?? undefined,
      sort: strParam(params, "sort", 10),
      dateFrom: dateFromParam(params),
      dateTo: dateToParam(params),
      page: pageParam(params),
      pageSize: pageSizeParam(params),
    });
    return adminJson({ ok: true, ...result });
  } catch (error) {
    return adminError("refund review backlog", error);
  }
}
