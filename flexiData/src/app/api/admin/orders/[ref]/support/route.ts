import { requireAdminApi } from "@/lib/admin/auth";
import { adminError, adminJson } from "@/lib/admin/api";
import {
  applyOrderSupportAction,
  normalizeOrderRef,
  parseSupportAction,
  supportActionRefusalMessage,
} from "@/lib/support-actions";

/**
 * `POST /api/admin/orders/[ref]/support` — record a support resolution for a
 * failed or stuck Paystack checkout order.
 *
 * This is the second (and last, for this step) write endpoint in the admin
 * area. Every safeguard is here, in order, so a reviewer can read them top to
 * bottom — the shape deliberately mirrors the Step 1 customer-status route:
 *
 *  1. `requireAdminApi()` is the first statement — the Phase 0 gate re-runs the
 *     full check (signed session cookie, live session row, users.is_admin,
 *     ADMIN_EMAILS) before anything else. Failures return the same 404 as
 *     Phase 0, byte-identical to anonymous access.
 *  2. The acting admin is `gate.context.admin.userId`, resolved server-side.
 *     The request body is never trusted to say who is performing the action —
 *     an `adminUserId` in the body is ignored by construction.
 *  3. The body must carry a supported `action` (`delivery_resolved` or
 *     `refund_review`), the target order reference echoed exactly, AND an
 *     explicit `confirm: true`. Without those, nothing is written.
 *  4. `applyOrderSupportAction` enforces eligibility against the live row,
 *     performs a conditional status update ONLY for `delivery_resolved`, and
 *     writes ONE audit row per effective action inside a single transaction.
 *
 * What this endpoint can never do: move money (no wallet, deposit, ledger,
 * refund or Paystack write), retry a delivery (no provider call), or invent a
 * delivery (the fulfilled transition is recorded only from an explicit admin
 * confirmation). A refund review is a RECORD of a pending finance decision.
 */
export const dynamic = "force-dynamic";

type SupportBody = {
  action?: unknown;
  orderRef?: unknown;
  confirm?: unknown;
  reason?: unknown;
  [key: string]: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ref: string }> },
) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const { ref } = await params;
  const orderRef = normalizeOrderRef(ref);
  if (!orderRef) {
    return adminJson({ ok: false, error: "Invalid order reference" }, 400);
  }

  let body: SupportBody;
  try {
    body = (await request.json()) as SupportBody;
  } catch {
    return adminJson({ ok: false, error: "Invalid request body" }, 400);
  }

  const action = parseSupportAction(body.action);
  if (!action) {
    return adminJson(
      { ok: false, error: "Invalid action — expected delivery_resolved or refund_review" },
      400,
    );
  }

  // Belt and braces, same as the suspend/activate route: the UI modal forces
  // the admin to type the exact order reference as the confirmation, and the
  // API independently refuses to act without `confirm: true` or when the
  // echoed reference does not match the path reference it was gated on.
  if (body.confirm !== true) {
    return adminJson({ ok: false, error: "Confirmation required" }, 400);
  }
  if (normalizeOrderRef(body.orderRef) !== orderRef) {
    return adminJson(
      { ok: false, error: "The order reference in the body must match the order being acted on" },
      400,
    );
  }

  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    const result = await applyOrderSupportAction({
      adminUserId: gate.context.admin.userId,
      orderRef,
      action,
      reason,
    });

    if (!result.ok) {
      const refusal = supportActionRefusalMessage(result);
      return adminJson({ ok: false, error: refusal.message }, refusal.status);
    }

    return adminJson({
      ok: true,
      ref: result.orderRef,
      action: result.action,
      changed: result.changed,
      orderStatus: result.orderStatus,
    });
  } catch (error) {
    return adminError("order support action", error);
  }
}
