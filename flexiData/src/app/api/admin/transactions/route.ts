import { requireAdminApi } from "@/lib/admin/auth";
import { loadTransactions } from "@/lib/admin/queries-operations";
import {
  adminError,
  adminJson,
  amountParam,
  dateFromParam,
  dateToParam,
  idParam,
  pageParam,
  pageSizeParam,
  searchParamsOf,
  strParam,
} from "@/lib/admin/api";

/**
 * `GET /api/admin/transactions` — the transaction explorer, server-side
 * filtered and paginated. Read-only; no transaction action exists in Phase 1.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  try {
    const params = searchParamsOf(request);
    const result = await loadTransactions({
      search: strParam(params, "search") ?? undefined,
      walletId: idParam(params, "walletId"),
      userId: idParam(params, "userId"),
      type: strParam(params, "type", 20),
      status: strParam(params, "status", 20),
      direction: strParam(params, "direction", 10),
      provider: strParam(params, "provider", 40),
      dateFrom: dateFromParam(params),
      dateTo: dateToParam(params),
      amountMin: amountParam(params, "amountMin"),
      amountMax: amountParam(params, "amountMax"),
      sort: strParam(params, "sort", 20),
      page: pageParam(params),
      pageSize: pageSizeParam(params),
    });
    return adminJson({ ok: true, ...result });
  } catch (error) {
    return adminError("transactions", error);
  }
}
