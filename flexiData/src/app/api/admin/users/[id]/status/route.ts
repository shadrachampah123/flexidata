import { requireAdminApi } from "@/lib/admin/auth";
import { adminError, adminJson } from "@/lib/admin/api";
import { setCustomerStatus, type AccountAction } from "@/lib/customer-management";

/**
 * `POST /api/admin/users/[id]/status` — suspend or activate a customer account.
 *
 * This is the first write endpoint in the admin area. Every safeguard is here,
 * in order, so a reviewer can read them top to bottom:
 *
 *  1. `requireAdminApi()` is the first statement — the Phase 0 gate re-runs the
 *     full check (signed fd_auth, live session, users.is_admin, ADMIN_EMAILS)
 *     before anything else. Failures return the same 404 as Phase 0.
 *  2. The acting admin is `gate.context.admin.userId`, resolved server-side.
 *     The request body is never trusted to say who is performing the action.
 *  3. The body must carry `action` in {suspend, activate} AND an explicit
 *     `confirm: true`. Without the literal confirmation nothing changes.
 *  4. `setCustomerStatus` performs a conditional UPDATE + audit INSERT in one
 *     transaction and refuses to touch administrators or a lagging schema.
 *
 * No wallet, deposit, transaction or order row is ever written here.
 */
export const dynamic = "force-dynamic";

type StatusBody = {
  action?: unknown;
  confirm?: unknown;
  reason?: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const userId = Number(id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return adminJson({ ok: false, error: "Invalid user id" }, 400);
  }

  let body: StatusBody;
  try {
    body = (await request.json()) as StatusBody;
  } catch {
    return adminJson({ ok: false, error: "Invalid request body" }, 400);
  }

  const action = body.action;
  if (action !== "suspend" && action !== "activate") {
    return adminJson({ ok: false, error: "Invalid action" }, 400);
  }

  // Belt and braces: the UI asks for an explicit confirmation, and the API
  // independently refuses to act without one.
  if (body.confirm !== true) {
    return adminJson({ ok: false, error: "Confirmation required" }, 400);
  }

  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    const result = await setCustomerStatus({
      adminUserId: gate.context.admin.userId,
      targetUserId: userId,
      action: action as AccountAction,
      reason,
    });

    if (!result.ok) {
      if (result.error === "user-not-found") {
        return adminJson({ ok: false, error: "User not found" }, 404);
      }
      if (result.error === "admin-account") {
        return adminJson(
          { ok: false, error: "Administrator accounts cannot be suspended" },
          400,
        );
      }
      // schema-drift: a generic failure, with the detail kept in the server log.
      return adminJson(
        {
          ok: false,
          error:
            "Customer status could not be changed because the database is missing the customer-management schema.",
        },
        500,
      );
    }

    return adminJson({
      ok: true,
      userId,
      status: result.accountStatus,
      changed: result.changed,
    });
  } catch (error) {
    return adminError("customer status change", error);
  }
}
