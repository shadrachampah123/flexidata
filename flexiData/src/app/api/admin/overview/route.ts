import { requireAdminApi } from "@/lib/admin/auth";
import { loadOverview } from "@/lib/admin/queries";
import { adminError, adminJson } from "@/lib/admin/api";

/**
 * `GET /api/admin/overview` — the operational snapshot behind `/admin`.
 *
 * `requireAdminApi()` is the FIRST statement: `src/proxy.ts` returns early for
 * every `/api/` path, so this call is the only thing standing between a customer
 * and the platform's operational data.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  try {
    return adminJson({ ok: true, overview: await loadOverview() });
  } catch (error) {
    return adminError("overview", error);
  }
}
