import { requireAdminApi } from "@/lib/admin/auth";

/**
 * `GET /api/admin/me` — Phase 0 smoke endpoint.
 *
 * The only job of this route is to prove that the API half of the admin gate
 * works, and to serve as the reference implementation every future
 * `/api/admin/**` handler must copy: **`requireAdminApi()` is the first
 * statement, before any input is read and before any query runs.**
 *
 * `src/proxy.ts` returns early for every `/api/` path, so API routes get NO
 * Edge protection whatsoever. A handler that forgets this call is completely
 * open. There is no framework-level safety net to fall back on.
 *
 * The response carries only the caller's own identity — no customer data, no
 * wallet data, no configuration, no secrets.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const { admin } = gate.context;

  return Response.json(
    {
      ok: true,
      admin: {
        userId: admin.userId,
        name: admin.name,
        email: admin.email,
        sessionId: admin.sessionId,
        via: admin.via,
      },
      phase: 0,
      capabilities: {
        // Phase 0 is the gate and nothing else. Spelled out so it is obvious in
        // the response that no data or control surface has been exposed yet.
        read: [],
        write: [],
      },
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
