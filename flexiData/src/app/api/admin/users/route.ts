import { requireAdminApi } from "@/lib/admin/auth";
import { loadUsers } from "@/lib/admin/queries";
import { adminError, adminJson, pageParam, pageSizeParam, searchParamsOf, strParam } from "@/lib/admin/api";

/**
 * `GET /api/admin/users` — search existing users, read-only.
 *
 * List rows carry masked emails and phone numbers; the single-user endpoint
 * (`/api/admin/users/[id]`) is the deliberately-opened view that shows the real
 * values. No create, update, suspend, role-change or password reset exists here.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  try {
    const params = searchParamsOf(request);
    const result = await loadUsers({
      search: strParam(params, "search") ?? undefined,
      sort: strParam(params, "sort", 20) ?? undefined,
      page: pageParam(params),
      pageSize: pageSizeParam(params),
    });
    return adminJson({ ok: true, ...result });
  } catch (error) {
    return adminError("users", error);
  }
}
