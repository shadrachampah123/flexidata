import { requireAdminApi } from "@/lib/admin/auth";
import { loadWallets } from "@/lib/admin/queries";
import {
  adminError,
  adminJson,
  boolParam,
  pageParam,
  pageSizeParam,
  searchParamsOf,
  strParam,
} from "@/lib/admin/api";

/**
 * `GET /api/admin/wallets` — READ-ONLY wallet monitoring.
 *
 * Returns the stored balance (authoritative) next to a ledger-derived figure
 * (diagnostic) for each wallet on the page. There is no write, no "fix" and no
 * parameter that can change a balance; the handler only reads.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  try {
    const params = searchParamsOf(request);
    const result = await loadWallets({
      search: strParam(params, "search") ?? undefined,
      sort: strParam(params, "sort", 20) ?? undefined,
      onlyMismatches: boolParam(params, "onlyMismatches"),
      page: pageParam(params),
      pageSize: pageSizeParam(params),
    });
    return adminJson({ ok: true, ...result });
  } catch (error) {
    return adminError("wallets", error);
  }
}
