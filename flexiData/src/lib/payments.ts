
/**
 * Wallet funding gateway.
 *
 * - `mock` (default): mobile money is simulated server-side and the wallet is
 *   credited immediately. Perfect for development and demos — no external
 *   account needed, but the money movement is a real, persisted ledger entry.
 * - `paystack`: real Ghanaian mobile-money / card checkout. The wallet is only
 *   credited after Paystack verifies the payment (see /api/payments/webhook
 *   and /api/payments/verify), the same flow GetDataGH uses.
 */

import {
  isValidPaystackWebhookSignature,
  paystackInitializeTransaction,
  paystackVerifyTransaction,
} from "@/lib/paystack";

export type PaymentMethod = "momo_mtn" | "telecel_cash" | "card";

export const PAYMENT_METHODS: Record<
  PaymentMethod,
  { label: string; network: "MTN" | "TELECEL" | null; channel: "momo" | "card" }
> = {
  momo_mtn: { label: "MTN MoMo", network: "MTN", channel: "momo" },
  telecel_cash: { label: "Telecel Cash", network: "TELECEL", channel: "momo" },
  card: { label: "Visa / Mastercard", network: null, channel: "card" },
};

export type InitPaymentResult =
  | {
      status: "completed";
      providerRef: string;
      authorizationUrl: null;
    }
  | {
      status: "pending";
      providerRef: string;
      authorizationUrl: string;
    };

export function paymentsProvider(): "mock" | "paystack" {
  return (process.env.PAYMENTS_PROVIDER ?? "mock").trim().toLowerCase() === "paystack"
    ? "paystack"
    : "mock";
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/**
 * Initialise a deposit. In mock mode the payment settles instantly. In Paystack
 * mode we create a charge and return the authorization URL the user is
 * redirected to; settlement happens in the webhook / verify call.
 */
export async function initPayment(params: {
  ref: string;
  amountGhs: number;
  email: string;
  method: PaymentMethod;
  phone: string;
}): Promise<InitPaymentResult> {
  const provider = paymentsProvider();

  if (provider === "mock") {
    // Simulated MoMo/card settlement: instant success, deterministic ref.
    return { status: "completed", providerRef: `mock-${params.ref}`, authorizationUrl: null };
  }

  // --- Paystack (shared server-only client: secret key never leaves it) ---
  const init = await paystackInitializeTransaction({
    reference: params.ref,
    amountSubunits: Math.round(params.amountGhs * 100), // pesewas
    email: params.email,
    callbackUrl: `${appBaseUrl()}/wallet?funding=success&ref=${encodeURIComponent(params.ref)}`,
    channels: PAYMENT_METHODS[params.method].channel === "momo" ? ["mobile_money"] : ["card"],
    metadata: { method: params.method, phone: params.phone, app: "flexidata" },
  });
  return {
    status: "pending",
    providerRef: init.reference,
    authorizationUrl: init.authorizationUrl,
  };
}

/** Verify a Paystack transaction by reference. Returns true when paid. */
export async function verifyPaystackPayment(ref: string): Promise<{ paid: boolean; amountGhs: number | null }> {
  if (paymentsProvider() !== "paystack") {
    // Mock deposits are credited at init time; verification is a no-op success.
    return { paid: true, amountGhs: null };
  }
  const verification = await paystackVerifyTransaction(ref);
  const paid = verification.status === "success";
  return {
    paid,
    amountGhs: verification.amountSubunits != null ? verification.amountSubunits / 100 : null,
  };
}

/** Validate a Paystack webhook signature (HMAC SHA512 of the raw body). */
export async function verifyPaystackSignature(rawBody: string, signature: string | null): Promise<boolean> {
  return isValidPaystackWebhookSignature(rawBody, signature);
}
