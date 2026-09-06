import { requireAdminApi } from "@/lib/admin/auth";
import {
  adminError,
  adminJson,
  dateFromParam,
  dateToParam,
  idParam,
  pageParam,
  pageSizeParam,
  searchParamsOf,
  strParam,
} from "@/lib/admin/api";
import { loadAdminAudit } from "@/lib/admin/queries-investigation";

/**
 * `GET /api/admin/audit` — the administrator activity trail.
 *
 * Phase 2, Step 3 (S3.4). Steps 1 and 2 wrote `admin_audit_logs` for every
 * state-changing admin action but nothing could read the trail back except a
 * SQL client. This is the read side of that accountability: who acted, on whom,
 * on which order, when and why.
 *
 * Read-only, paginated, capped by the existing `MAX_PAGE_SIZE` / `MAX_OFFSET`
 * limits, masked (list view), and schema-drift aware: on a database without
 * `admin_audit_logs` it answers `available: false` with an empty page instead of
 * throwing, and on one without `target_ref` it omits order references.
 *
 * It writes nothing — including to the trail it reads. The Step 3 harness
 * asserts the row count is unchanged after a full sweep of this endpoint.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  try {
    const params = searchParamsOf(request);
    const result = await loadAdminAudit({
      admin: idParam(params, "admin"),
      action: strParam(params, "action", 40),
      userId: idParam(params, "userId"),
      search: strParam(params, "search") ?? undefined,
      dateFrom: dateFromParam(params),
      dateTo: dateToParam(params),
      page: pageParam(params),
      pageSize: pageSizeParam(params),
    });
    return adminJson({ ok: true, ...result });
  } catch (error) {
    return adminError("admin activity log", error);
  }
}
