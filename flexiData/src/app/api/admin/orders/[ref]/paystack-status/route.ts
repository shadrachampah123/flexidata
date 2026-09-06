import { requireAdminApi } from "@/lib/admin/auth";
import { adminError, adminJson } from "@/lib/admin/api";
import { parseRef } from "@/lib/admin/filters";
import { loadOrderInvestigation } from "@/lib/admin/queries-investigation";
import { probePaystackStatus } from "@/lib/admin/paystack-status";
import type { ProbeSubject } from "@/lib/admin/diagnosis";

/**
 * `GET /api/admin/orders/[ref]/paystack-status` — ask Paystack what it holds for
 * one checkout order, and compare it with what we stored. Read-only. (S3.6)
 *
 * Why this exists: the only other code that asks Paystack about a reference is
 * `reconcileCheckoutOrder()`, which SETTLES — conditional UPDATE, fulfilment,
 * ledger mirror. So an administrator facing an order parked by the
 * verification-mismatch guard had no way to learn whether the gateway really
 * took the money without moving it. This endpoint calls
 * `paystackVerifyTransaction()` and nothing else: no settlement function is
 * imported, no database write exists in the module that performs the call, and
 * the comparison uses the same reference / pesewa / currency predicates the
 * settlement path applies.
 *
 * `GET` rather than `POST` on purpose: it writes nothing, so it must not become
 * a third browser write surface — the admin UI's write surface stays exactly the
 * two confirmation modals the Phase 1/2 harnesses allowlist. It is
 * `force-dynamic` and `no-store`, so it is never cached or prefetched.
 *
 * Order of operations: gate → reference validation → the order must exist in our
 * own database (the stored values the probe compares against come from that
 * read) → throttled, time-bounded outbound call.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const { ref } = await params;
  const orderRef = parseRef(ref);
  if (!orderRef) {
    return adminJson({ ok: false, error: "Invalid order reference" }, 400);
  }

  try {
    const investigation = await loadOrderInvestigation(orderRef);
    if (!investigation) {
      return adminJson({ ok: false, error: "Order not found" }, 404);
    }

    const subject: ProbeSubject = {
      kind: "order",
      ref: orderRef,
      storedStatus: investigation.order.paymentStatus,
      storedAmountSubunits: investigation.order.amountSubunits,
      storedCurrency: investigation.order.currency,
      storedTransactionId: investigation.order.paystackTransactionId,
    };

    const result = await probePaystackStatus({
      adminUserId: gate.context.admin.userId,
      subject,
    });

    if (!result.ok) {
      const status =
        result.error === "throttled"
          ? 429
          : result.error === "unavailable"
            ? 503
            : result.error === "timeout"
              ? 504
              : 502;
      return adminJson(result, status);
    }
    return adminJson(result);
  } catch (error) {
    return adminError("paystack order status probe", error);
  }
}
