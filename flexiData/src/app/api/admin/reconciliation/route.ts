import { requireAdminApi } from "@/lib/admin/auth";
import { loadReconciliation } from "@/lib/admin/queries";
import {
  adminError,
  adminJson,
  boolParam,
  idParam,
  pageParam,
  pageSizeParam,
  searchParamsOf,
  strParam,
} from "@/lib/admin/api";

/**
 * `GET /api/admin/reconciliation` — stored balance vs ledger-derived balance.
 *
 * A diagnostic: it reports differences and classifies them, never corrects
 * them. `?onlyMismatches=1` narrows the list to wallets whose stored balance
 * disagrees with the calculated one.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  try {
    const params = searchParamsOf(request);
    const result = await loadReconciliation({
      search: strParam(params, "search") ?? undefined,
      onlyMismatches: boolParam(params, "onlyMismatches") || strParam(params, "only", 20) === "mismatches",
      page: pageParam(params),
      pageSize: pageSizeParam(params),
      walletId: idParam(params, "walletId"),
    });
    return adminJson({ ok: true, ...result });
  } catch (error) {
    return adminError("reconciliation", error);
  }
}
