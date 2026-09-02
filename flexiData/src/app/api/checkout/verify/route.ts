import { requireAccount } from "@/lib/api-auth";
import { getCheckoutOrder, reconcileCheckoutOrder } from "@/lib/checkout";
import { PaystackConfigError, PaystackRequestError } from "@/lib/paystack";
import { isMissingRelationError } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

/**
 * Called by the checkout-complete page after the customer returns from
 * Paystack (and safe to poll). Confirms the payment directly with Paystack —
 * the redirect itself proves nothing — then settles + fulfils idempotently.
 * Scoped to the signed-in owner of the order; responses carry only public
 * order state.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => ({}))) as { ref?: string };
    const ref = (body.ref ?? "").trim();
    if (!ref) return Response.json({ ok: false, error: "Missing reference" }, { status: 400 });

    const order = await getCheckoutOrder(ref);
    if (!order || order.userId !== auth.userId) {
      // Same response for "not yours" and "does not exist".
      return Response.json({ ok: false, error: "Order not found" }, { status: 404 });
    }

    const summary = await reconcileCheckoutOrder(ref);
    if (!summary) return Response.json({ ok: false, error: "Order not found" }, { status: 404 });

    return Response.json(
      { ok: true, order: summary },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    if (error instanceof PaystackConfigError || error instanceof PaystackRequestError) {
      console.error("checkout verify error:", error.message);
      return Response.json(
        { ok: false, error: "Could not confirm the payment yet. Please try again in a moment.", code: "verify_unavailable" },
        { status: 502 },
      );
    }
    if (isMissingRelationError(error)) {
      return Response.json(
        { ok: false, error: "Checkout is being upgraded. Please try again shortly.", code: "schema_out_of_date" },
        { status: 503 },
      );
    }
    console.error("checkout verify error", error);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
