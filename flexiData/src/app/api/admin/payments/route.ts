import { requireAdminApi } from "@/lib/admin/auth";
import { loadPayments } from "@/lib/admin/queries-operations";
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
 * `GET /api/admin/payments` — deposit / Paystack activity, read-only.
 *
 * No Paystack API is called, nothing is retried and nothing is refunded: this
 * reads `deposit_requests` and reports whether the matching wallet credit
 * exists in the ledger.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  try {
    const params = searchParamsOf(request);
    const result = await loadPayments({
      search: strParam(params, "search") ?? undefined,
      status: strParam(params, "status", 20),
      provider: strParam(params, "provider", 40),
      channel: strParam(params, "channel", 40),
      walletId: idParam(params, "walletId"),
      userId: idParam(params, "userId"),
      dateFrom: dateFromParam(params),
      dateTo: dateToParam(params),
      amountMin: amountParam(params, "amountMin"),
      amountMax: amountParam(params, "amountMax"),
      credit: strParam(params, "credit", 20),
      sort: strParam(params, "sort", 20),
      page: pageParam(params),
      pageSize: pageSizeParam(params),
    });
    return adminJson({ ok: true, ...result });
  } catch (error) {
    return adminError("payments", error);
  }
}
