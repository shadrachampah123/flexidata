import { paymentsProvider } from "@/lib/payments";
import { isPaystackConfigured, isValidPaystackWebhookSignature, PaystackConfigError } from "@/lib/paystack";
import { getCheckoutOrder, reconcileCheckoutOrder } from "@/lib/checkout";
import { getDeposit, reconcileDeposit } from "@/lib/deposits";
import { isMissingRelationError } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

/** Event types that can change an order/deposit state. Everything else is acked and ignored. */
const RELEVANT_EVENTS = new Set(["charge.success", "charge.failed", "charge.abandoned"]);

/**
 * Paystack server-to-server webhook.
 *
 * Security model:
 *  1. The `x-paystack-signature` header (HMAC-SHA512 of the raw body with the
 *     secret key) is verified in constant time before the body is even parsed.
 *  2. The event payload is then treated ONLY as a hint carrying a reference.
 *     Nothing is settled from the payload itself — the reference is
 *     re-verified against Paystack's verify API, which makes replayed or
 *     re-delivered webhooks harmless: they just re-run an idempotent
 *     reconciliation that cannot settle a payment or submit a bundle twice.
 *  3. Responses are always minimal and never echo payload contents.
 */
export async function POST(req: Request) {
  try {
    if (!isPaystackConfigured()) {
      // No secret key -> signatures cannot be verified -> accept nothing.
      return Response.json({ ok: true, ignored: true });
    }

    const raw = await req.text();
    const signature = req.headers.get("x-paystack-signature");
    if (!isValidPaystackWebhookSignature(raw, signature)) {
      return Response.json({ ok: false }, { status: 401 });
    }

    let event: { event?: string; data?: { reference?: string } };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return Response.json({ ok: true, ignored: "unparseable" });
    }

    const ref = event.data?.reference;
    if (!event.event || !RELEVANT_EVENTS.has(event.event) || typeof ref !== "string" || !ref) {
      return Response.json({ ok: true, ignored: event.event ?? "unknown" });
    }

    // --- Data bundle checkout orders (Paystack pay-as-you-go) -------------
    let checkoutOrder = null;
    try {
      checkoutOrder = await getCheckoutOrder(ref);
    } catch (error) {
      if (!isMissingRelationError(error)) throw error;
      // checkout_orders not migrated yet — fall through to deposits.
    }
    if (checkoutOrder) {
      // reconcile re-verifies with Paystack and settles/fulfils idempotently.
      await reconcileCheckoutOrder(ref);
      return Response.json({ ok: true });
    }

    // --- Wallet deposits ---------------------------------------------------
    try {
      if (paymentsProvider() !== "paystack") {
        // Mock deposits settle at init; a signed Paystack event cannot apply.
        return Response.json({ ok: true, ignored: "deposits_not_paystack" });
      }
    } catch (error) {
      if (error instanceof PaystackConfigError) {
        // Production funding lockout (mock provider / missing key): deposits
        // can never be settled here, so ack and ignore instead of 500-retrying
        // a webhook that can never succeed. Nothing is credited either way.
        console.error(`webhook deposits locked: ${error.message}`);
        return Response.json({ ok: true, ignored: "deposits_locked" });
      }
      throw error;
    }

    let deposit = null;
    try {
      deposit = await getDeposit(ref);
    } catch (error) {
      if (!isMissingRelationError(error)) throw error;
      // deposit_requests not migrated yet — nothing to reconcile.
      return Response.json({ ok: true, ignored: "deposits_unavailable" });
    }
    if (!deposit) return Response.json({ ok: true, ignored: "unknown_ref" });

    // reconcileDeposit re-verifies with Paystack (never trusts this payload),
    // enforces reference + exact pesewa amount + currency, and settles
    // idempotently in one transaction. charge.failed / charge.abandoned are
    // also reconciled so the deposit row reaches the correct terminal state.
    await reconcileDeposit(ref);

    return Response.json({ ok: true });
  } catch (error) {
    console.error("webhook error", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
