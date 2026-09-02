import { settleDeposit } from "@/app/api/wallet/fund/route";
import { paymentsProvider, verifyPaystackPayment } from "@/lib/payments";
import { isPaystackConfigured, isValidPaystackWebhookSignature } from "@/lib/paystack";
import { getCheckoutOrder, reconcileCheckoutOrder } from "@/lib/checkout";
import { isMissingRelationError } from "@/lib/schema-compat";
import { db } from "@/db";
import { depositRequests } from "@/db/schema";
import { eq } from "drizzle-orm";

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
    if (paymentsProvider() !== "paystack") {
      // Mock deposits settle at init; a signed Paystack event cannot apply.
      return Response.json({ ok: true, ignored: "deposits_not_paystack" });
    }
    const rows = await db
      .select({ ref: depositRequests.ref, amount: depositRequests.amount, status: depositRequests.status })
      .from(depositRequests)
      .where(eq(depositRequests.ref, ref))
      .limit(1);
    const deposit = rows[0];
    if (!deposit) return Response.json({ ok: true, ignored: "unknown_ref" });

    if (event.event === "charge.success" && deposit.status !== "successful") {
      // Never credit from the payload: confirm with Paystack and check the
      // amount actually charged against the amount we recorded at init.
      const { paid, amountGhs } = await verifyPaystackPayment(ref);
      const expected = Number(deposit.amount);
      if (paid && (amountGhs == null || Math.abs(amountGhs - expected) < 0.005)) {
        await settleDeposit(ref);
      } else if (paid) {
        console.error(`[webhook] deposit ${ref} amount mismatch: got ${amountGhs}, expected ${expected}`);
      }
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("webhook error", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
