import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { bundlePlans, checkoutOrders, wallets } from "@/db/schema";
import { insertTransactionRow } from "@/lib/data";
import { creditReferralReward } from "@/lib/referrals";
import {
  deriveProviderProductCode,
  getStoredProviderFloatBalance,
  projectProviderFloatUsage,
  submitDataBundleOrder,
  upsertProviderFloatBalance,
} from "@/lib/data-gateway";
import {
  PAYSTACK_CURRENCY,
  PaystackConfigError,
  PaystackRequestError,
  paystackInitializeTransaction,
  paystackVerifyTransaction,
} from "@/lib/paystack";
import { hasBundlePlanColumn, withSchemaFallback, type SchemaCapabilities } from "@/lib/schema-compat";
import { repairCheckoutOrdersSchema } from "@/lib/seed";
import { POINTS_RATE } from "@/lib/constants";
import { groupPhone, isValidPhone, makeRef } from "@/lib/format";

/**
 * Paystack checkout orders for data bundles.
 *
 * Money-safety rules encoded here:
 *
 *  1. The price is ALWAYS read from `bundle_plans` on the server. The client
 *     only names a plan; it can never influence the amount.
 *  2. An order is only ever marked paid after `paystackVerifyTransaction`
 *     (server → Paystack, secret key) confirms status=success AND the exact
 *     integer amount in pesewas AND the currency AND the reference. Webhook
 *     payloads and browser redirects are treated as untrusted hints.
 *  3. Fulfillment (the YenkoData submission) happens at most once per order,
 *     enforced by an atomic conditional UPDATE (`paid` → `fulfilling`) that
 *     only one caller can win, no matter how many duplicate webhooks or
 *     verify calls race each other.
 *  4. A fulfillment attempt that errors is parked as `fulfillment_failed`
 *     and is NOT retried automatically: the gateway may have accepted the
 *     order before the error, so an auto-retry could double-send data.
 */

export class CheckoutInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutInputError";
  }
}

export type CheckoutOrderRow = typeof checkoutOrders.$inferSelect;

export type CheckoutOrderSummary = {
  ref: string;
  paymentStatus: CheckoutOrderRow["paymentStatus"];
  orderStatus: CheckoutOrderRow["orderStatus"];
  fulfillmentStatus: CheckoutOrderRow["fulfillmentStatus"];
  network: string;
  planLabel: string;
  recipient: string;
  amount: number;
  currency: string;
  providerMessage: string | null;
  paidAt: string | null;
  fulfilledAt: string | null;
  createdAt: string;
};

function clampText(value: string | null | undefined, max = 240): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function toCheckoutSummary(order: CheckoutOrderRow): CheckoutOrderSummary {
  return {
    ref: order.ref,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    network: order.network,
    planLabel: order.planLabel,
    recipient: order.recipient,
    amount: Number(order.amount),
    currency: order.currency,
    providerMessage: order.providerMessage,
    paidAt: order.paidAt?.toISOString() ?? null,
    fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
  };
}

type FoundPlan = {
  network: string;
  category: string;
  label: string;
  price: string;
  providerProductCode: string;
};

/** Server-side plan lookup (same schema-compat behaviour as /api/purchase). */
async function findBundlePlan(
  network: string,
  category: string,
  label: string,
  compat: SchemaCapabilities,
): Promise<FoundPlan | null> {
  const where = and(
    eq(bundlePlans.network, network),
    eq(bundlePlans.category, category),
    eq(bundlePlans.label, label),
  );

  if (hasBundlePlanColumn(compat, "providerProductCode")) {
    const rows = await db
      .select({
        network: bundlePlans.network,
        category: bundlePlans.category,
        label: bundlePlans.label,
        price: bundlePlans.price,
        providerProductCode: bundlePlans.providerProductCode,
      })
      .from(bundlePlans)
      .where(where)
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      providerProductCode:
        row.providerProductCode?.trim() || deriveProviderProductCode(network, category, label),
    };
  }

  const rows = await db
    .select({
      network: bundlePlans.network,
      category: bundlePlans.category,
      label: bundlePlans.label,
      price: bundlePlans.price,
    })
    .from(bundlePlans)
    .where(where)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, providerProductCode: deriveProviderProductCode(network, category, label) };
}

function appBaseUrl(requestOrigin: string | null): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (requestOrigin) return requestOrigin.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

/**
 * Step 1–4 of the flow: validate the selection server-side, create the unique
 * order reference, record the order as `awaiting_payment`, initialise the
 * Paystack transaction with the secret key and hand back the redirect URL.
 */
export async function createCheckoutOrder(params: {
  userId: number;
  walletId: number;
  customerEmail: string;
  customerPhone: string;
  network: string;
  category: string;
  planLabel: string;
  recipient: string;
  requestOrigin: string | null;
}): Promise<{ ref: string; authorizationUrl: string; amount: number; planLabel: string }> {
  const network = params.network?.trim().toUpperCase();
  if (network !== "MTN" && network !== "TELECEL") {
    throw new CheckoutInputError("Choose a network.");
  }
  const recipient = params.recipient?.trim() ?? "";
  if (!isValidPhone(recipient)) {
    throw new CheckoutInputError("Enter a valid recipient number.");
  }
  const category = params.category?.trim() ?? "";
  const planLabel = params.planLabel?.trim() ?? "";
  if (!category || !planLabel) {
    throw new CheckoutInputError("Choose a data bundle.");
  }

  // The ONLY price source is the catalog row — never the client.
  const plan = await withSchemaFallback(
    (compat) => findBundlePlan(network, category, planLabel, compat),
    "bundle plan lookup",
  );
  if (!plan) throw new CheckoutInputError("Bundle not found.");

  const amount = Number(plan.price);
  const amountSubunits = Math.round(amount * 100);
  if (!Number.isInteger(amountSubunits) || amountSubunits <= 0) {
    throw new CheckoutInputError("This bundle cannot be purchased right now.");
  }

  const ref = makeRef("CO");

  // Record the order BEFORE talking to Paystack so a redirect can never be
  // orphaned: whatever happens next, the reference exists in our database.
  await db.insert(checkoutOrders).values({
    ref,
    userId: params.userId,
    walletId: params.walletId,
    customerEmail: params.customerEmail,
    customerPhone: params.customerPhone,
    network,
    category,
    planLabel: plan.label,
    providerProductCode: plan.providerProductCode,
    recipient,
    amount: amount.toFixed(2),
    amountSubunits,
    currency: PAYSTACK_CURRENCY,
    paymentStatus: "pending",
    orderStatus: "awaiting_payment",
    fulfillmentStatus: "queued",
  });

  try {
    const init = await paystackInitializeTransaction({
      reference: ref,
      amountSubunits,
      email: params.customerEmail,
      callbackUrl: `${appBaseUrl(params.requestOrigin)}/checkout/complete?ref=${encodeURIComponent(ref)}`,
      metadata: {
        app: "flexidata",
        kind: "data_bundle",
        network,
        plan: plan.label,
        recipient,
        custom_fields: [
          { display_name: "Bundle", variable_name: "bundle", value: `${network} ${plan.label}` },
          { display_name: "Recipient", variable_name: "recipient", value: groupPhone(recipient) },
        ],
      },
    });

    return { ref, authorizationUrl: init.authorizationUrl, amount, planLabel: plan.label };
  } catch (error) {
    // Initialization never reached checkout: close the order immediately.
    await db
      .update(checkoutOrders)
      .set({
        paymentStatus: "failed",
        orderStatus: "payment_failed",
        failedAt: new Date(),
        updatedAt: new Date(),
        paystackGatewayResponse: clampText(
          error instanceof PaystackRequestError || error instanceof PaystackConfigError
            ? error.message
            : "initialization error",
        ),
      })
      .where(eq(checkoutOrders.ref, ref))
      .catch(() => undefined);
    throw error;
  }
}

export async function getCheckoutOrder(ref: string): Promise<CheckoutOrderRow | null> {
  const rows = await db.select().from(checkoutOrders).where(eq(checkoutOrders.ref, ref)).limit(1);
  return rows[0] ?? null;
}

/**
 * Steps 5–9: confirm the payment directly with Paystack, settle the order
 * idempotently and fulfil it (submit to the data provider) at most once.
 * Safe to call any number of times from the webhook, the redirect page and
 * manual polling — duplicates are absorbed by conditional UPDATEs.
 */
export async function reconcileCheckoutOrder(ref: string): Promise<CheckoutOrderSummary | null> {
  const order = await getCheckoutOrder(ref);
  if (!order) return null;

  // Terminal fulfillment states never change again.
  if (order.orderStatus === "fulfilled" || order.orderStatus === "fulfillment_failed") {
    return toCheckoutSummary(order);
  }

  // Already verified as paid (e.g. webhook landed first): only fulfillment
  // may still be outstanding.
  if (order.paymentStatus === "successful") {
    await fulfillPaidOrder(ref);
    return toCheckoutSummary((await getCheckoutOrder(ref)) ?? order);
  }

  // Ask Paystack — the single source of truth — what happened.
  const verification = await paystackVerifyTransaction(ref);
  const now = new Date();

  if (verification.status === "success") {
    // Enforce reference + amount + currency before treating it as paid.
    const referenceOk = verification.reference === order.ref;
    const amountOk = verification.amountSubunits === order.amountSubunits;
    const currencyOk = (verification.currency ?? "").toUpperCase() === order.currency.toUpperCase();

    if (!referenceOk || !amountOk || !currencyOk) {
      // A "successful" charge that does not match what we asked for is never
      // fulfilled. Park it for manual review. (Log has amounts only — safe.)
      console.error(
        `[checkout] verification mismatch for ${order.ref}: ` +
          `amount ${verification.amountSubunits}/${order.amountSubunits}, ` +
          `currency ${verification.currency}/${order.currency}, referenceOk=${referenceOk}`,
      );
      await db
        .update(checkoutOrders)
        .set({
          paymentStatus: "failed",
          orderStatus: "payment_failed",
          failedAt: now,
          verifiedAt: now,
          updatedAt: now,
          paystackTransactionId: verification.transactionId,
          paystackGatewayResponse: clampText(
            "Payment did not match the order (amount/currency/reference) and was not fulfilled. Contact support for a refund.",
          ),
        })
        .where(
          and(
            eq(checkoutOrders.ref, ref),
            inArray(checkoutOrders.paymentStatus, ["pending", "abandoned", "failed"]),
          ),
        );
      return toCheckoutSummary((await getCheckoutOrder(ref)) ?? order);
    }

    // Idempotent settle: only one caller can move the order to paid.
    const settled = await db
      .update(checkoutOrders)
      .set({
        paymentStatus: "successful",
        orderStatus: "paid",
        paidAt: verification.paidAt ?? now,
        verifiedAt: now,
        updatedAt: now,
        paystackTransactionId: verification.transactionId,
        paystackChannel: verification.channel,
        paystackGatewayResponse: clampText(verification.gatewayResponse),
      })
      .where(
        and(
          eq(checkoutOrders.ref, ref),
          // A failed/abandoned attempt CAN still become successful (customer
          // retried inside the same Paystack checkout) — but a successful
          // order can never be settled twice.
          inArray(checkoutOrders.paymentStatus, ["pending", "abandoned", "failed"]),
        ),
      )
      .returning({ id: checkoutOrders.id });

    if (settled.length > 0) {
      await fulfillPaidOrder(ref);
    }
    return toCheckoutSummary((await getCheckoutOrder(ref)) ?? order);
  }

  if (verification.status === "failed" || verification.status === "reversed") {
    await db
      .update(checkoutOrders)
      .set({
        paymentStatus: "failed",
        orderStatus: "payment_failed",
        failedAt: now,
        verifiedAt: now,
        updatedAt: now,
        paystackTransactionId: verification.transactionId,
        paystackGatewayResponse: clampText(verification.gatewayResponse ?? verification.rawStatus),
      })
      .where(
        and(eq(checkoutOrders.ref, ref), inArray(checkoutOrders.paymentStatus, ["pending", "abandoned"])),
      );
    return toCheckoutSummary((await getCheckoutOrder(ref)) ?? order);
  }

  if (verification.status === "abandoned") {
    await db
      .update(checkoutOrders)
      .set({
        paymentStatus: "abandoned",
        orderStatus: "abandoned",
        abandonedAt: now,
        verifiedAt: now,
        updatedAt: now,
        paystackGatewayResponse: clampText(verification.gatewayResponse ?? "Checkout abandoned"),
      })
      .where(and(eq(checkoutOrders.ref, ref), eq(checkoutOrders.paymentStatus, "pending")));
    return toCheckoutSummary((await getCheckoutOrder(ref)) ?? order);
  }

  // Still pending at Paystack — nothing to change yet.
  return toCheckoutSummary(order);
}

/**
 * Submit a verified-paid order to the data provider exactly once.
 *
 * The `paid → fulfilling` transition is the idempotency lock: a conditional
 * UPDATE that only one concurrent caller can win. Everyone else sees zero
 * affected rows and returns without touching the provider, so duplicate
 * webhooks can never double-send a bundle.
 */
async function fulfillPaidOrder(ref: string): Promise<void> {
  const claimed = await db
    .update(checkoutOrders)
    .set({ orderStatus: "fulfilling", fulfillmentStatus: "submitted", updatedAt: new Date() })
    .where(and(eq(checkoutOrders.ref, ref), eq(checkoutOrders.orderStatus, "paid")))
    .returning();
  const order = claimed[0];
  if (!order) return; // Someone else is fulfilling / already fulfilled.

  const amount = Number(order.amount);

  try {
    const gateway = await submitDataBundleOrder({
      reference: order.ref,
      walletId: order.walletId,
      network: order.network as "MTN" | "TELECEL",
      recipient: order.recipient,
      planLabel: order.planLabel,
      category: order.category,
      providerProductCode: order.providerProductCode,
      amount,
    });

    const now = new Date();
    const gatewayFailed = gateway.status === "failed" || gateway.status === "reversed";
    const delivered = gateway.status === "successful";

    await db
      .update(checkoutOrders)
      .set({
        orderStatus: gatewayFailed ? "fulfillment_failed" : delivered ? "fulfilled" : "fulfilling",
        fulfillmentStatus: gateway.fulfillmentStatus,
        providerReference: gateway.providerReference,
        providerStatus: clampText(gateway.providerStatus, 80),
        providerMessage: clampText(gateway.providerMessage),
        fulfilledAt: delivered ? now : null,
        failedAt: gatewayFailed ? now : order.failedAt,
        updatedAt: now,
      })
      .where(eq(checkoutOrders.ref, ref));

    // Mirror the order into the ledger so history and /track/[ref] work the
    // same as wallet purchases. Payment was taken by Paystack, so the wallet
    // balance is untouched; only loyalty points are credited.
    const pointsEarned = delivered ? Math.max(1, Math.round(amount * POINTS_RATE)) : 0;
    const subtitle = gatewayFailed
      ? `To ${groupPhone(order.recipient)} • Paid via Paystack • Fulfillment needs attention`
      : `To ${groupPhone(order.recipient)} • Paid via Paystack`;

    await insertTransactionRow({
      ref: order.ref,
      walletId: order.walletId,
      type: "data",
      status: gatewayFailed ? "failed" : delivered ? "successful" : "pending",
      fulfillmentStatus: gateway.fulfillmentStatus,
      direction: "out",
      title: `${order.network} ${order.planLabel} Data`,
      subtitle,
      amount: amount.toFixed(2),
      points: pointsEarned,
      network: order.network,
      recipient: order.recipient,
      provider: gateway.providerCode,
      providerProductCode: order.providerProductCode,
      providerReference: gateway.providerReference,
      providerStatus: gateway.providerStatus,
      providerMessage: clampText(gateway.providerMessage),
      fulfillmentAttempts: 1,
      chargedAt: order.paidAt ?? now,
      fulfilledAt: delivered ? now : null,
      lastProviderSyncAt: now,
      providerPayload: gateway.rawRequest,
      providerResponse: gateway.rawResponse,
    }).catch((e) => console.error("checkout ledger write error", e));

    if (pointsEarned > 0) {
      const walletRows = await db
        .select({ points: wallets.points })
        .from(wallets)
        .where(eq(wallets.id, order.walletId))
        .limit(1);
      if (walletRows[0]) {
        await db
          .update(wallets)
          .set({ points: walletRows[0].points + pointsEarned })
          .where(eq(wallets.id, order.walletId));
      }
    }

    // Float bookkeeping, same as the wallet purchase path.
    if (gateway.floatBalance != null) {
      const storedFloat = await getStoredProviderFloatBalance(order.network);
      await upsertProviderFloatBalance({
        providerCode: gateway.providerCode,
        network: order.network,
        availableBalance: gateway.floatBalance,
        reservedBalance:
          gateway.status === "pending"
            ? (storedFloat?.reservedBalance ?? 0) + amount
            : storedFloat?.reservedBalance ?? 0,
        lowBalanceThreshold: storedFloat?.lowBalanceThreshold ?? 0,
        lastReference: order.ref,
        lastStatus: gateway.providerStatus ?? gateway.status,
        notes: gateway.providerMessage,
        lastSyncedAt: now,
      }).catch((e) => console.error("checkout float sync error", e));
    } else {
      await projectProviderFloatUsage({
        providerCode: gateway.providerCode,
        network: order.network as "MTN" | "TELECEL",
        amount,
        status: gateway.status,
        reference: order.ref,
        message: gateway.providerMessage,
      }).catch((e) => console.error("checkout float projection error", e));
    }

    if (delivered) {
      await creditReferralReward(order.userId, order.walletId).catch((e) =>
        console.error("referral reward error", e),
      );
    }
  } catch (error) {
    // The provider call itself blew up. The order stays parked as
    // fulfillment_failed and is NEVER auto-retried: the gateway may have
    // accepted the submission before the error, and a retry could deliver
    // the bundle twice. Support resolves these manually.
    console.error(`[checkout] fulfillment error for ${ref}`, error);
    await db
      .update(checkoutOrders)
      .set({
        orderStatus: "fulfillment_failed",
        fulfillmentStatus: "failed",
        providerMessage: clampText(
          "The data provider could not be reached after payment. Support will fulfil or refund this order.",
        ),
        failedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(checkoutOrders.ref, ref), eq(checkoutOrders.orderStatus, "fulfilling")))
      .catch(() => undefined);
  }
}
