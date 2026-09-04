import { requireAdminApi } from "@/lib/admin/auth";
import { loadUserDetail } from "@/lib/admin/queries";
import { adminError, adminJson } from "@/lib/admin/api";

/**
 * `GET /api/admin/users/[id]` — one customer: identity, wallets, recent
 * sessions, recent transactions and recent orders. Read-only.
 *
 * Sessions are included because a login trail (IP / user-agent / last seen) is
 * what an operator needs when investigating a disputed account, and it is the
 * deliberate single-record view rather than a bulk list.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const userId = Number(id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return adminJson({ ok: false, error: "Invalid user id" }, 400);
  }

  try {
    const detail = await loadUserDetail(userId);
    if (!detail) return adminJson({ ok: false, error: "User not found" }, 404);
    return adminJson({ ok: true, ...detail });
  } catch (error) {
    return adminError("user detail", error);
  }
}
