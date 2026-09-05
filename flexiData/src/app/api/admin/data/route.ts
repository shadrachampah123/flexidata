import { requireAdminApi } from "@/lib/admin/auth";
import { loadDataOrders, type DataChannel } from "@/lib/admin/queries-operations";
import {
  adminError,
  adminJson,
  amountParam,
  dateFromParam,
  dateToParam,
  pageParam,
  pageSizeParam,
  searchParamsOf,
  strParam,
} from "@/lib/admin/api";

/**
 * `GET /api/admin/data` — data purchase / delivery activity.
 *
 * `?channel=wallet`   wallet-funded orders (the `transactions` ledger)
 * `?channel=checkout` Paystack pay-as-you-go orders (`checkout_orders`)
 *
 * Read-only: no retry, resend, refund or status change is possible here.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  try {
    const params = searchParamsOf(request);
    const channel: DataChannel = strParam(params, "channel", 10) === "checkout" ? "checkout" : "wallet";
    const result = await loadDataOrders({
      channel,
      search: strParam(params, "search") ?? undefined,
      bucket: (strParam(params, "bucket", 20) ?? null) as never,
      network: strParam(params, "network", 10),
      dateFrom: dateFromParam(params),
      dateTo: dateToParam(params),
      amountMin: amountParam(params, "amountMin"),
      amountMax: amountParam(params, "amountMax"),
      page: pageParam(params),
      pageSize: pageSizeParam(params),
    });
    return adminJson({ ok: true, ...result });
  } catch (error) {
    return adminError("data orders", error);
  }
}
