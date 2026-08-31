
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

function paystackSecret(): string {
  const key = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!key) {
    throw new Error(
      "PAYSTACK_SECRET_KEY is not set. Add it to your environment to take live payments, " +
        "or leave PAYMENTS_PROVIDER=mock for simulated MoMo funding.",
    );
  }
  return key;
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

  // --- Paystack ----------------------------------------------------------
  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paystackSecret()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: params.email,
      amount: Math.round(params.amountGhs * 100), // pesewas
      reference: params.ref,
      currency: "GHS",
      callback_url: `${appBaseUrl()}/wallet?funding=success&ref=${encodeURIComponent(params.ref)}`,
      metadata: { method: params.method, phone: params.phone, app: "flexidata" },
      ...(PAYMENT_METHODS[params.method].channel === "momo"
        ? { channels: ["mobile_money"] }
        : { channels: ["card"] }),
    }),
  });

  const data = (await res.json()) as {
    status?: boolean;
    data?: { reference?: string; authorization_url?: string };
    message?: string;
  };
  if (!res.ok || !data.status || !data.data?.authorization_url) {
    throw new Error(data.message ?? "Could not start the payment. Please try again.");
  }
  return {
    status: "pending",
    providerRef: data.data.reference ?? params.ref,
    authorizationUrl: data.data.authorization_url,
  };
}

/** Verify a Paystack transaction by reference. Returns true when paid. */
export async function verifyPaystackPayment(ref: string): Promise<{ paid: boolean; amountGhs: number | null }> {
  if (paymentsProvider() !== "paystack") {
    // Mock deposits are credited at init time; verification is a no-op success.
    return { paid: true, amountGhs: null };
  }
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${paystackSecret()}` },
  });
  const data = (await res.json()) as {
    status?: boolean;
    data?: { status?: string; amount?: number };
  };
  const paid = data.status === true && data.data?.status === "success";
  return { paid, amountGhs: data.data?.amount ? data.data.amount / 100 : null };
}

/** Validate a Paystack webhook signature (HMAC SHA512 of the raw body). */
export async function verifyPaystackSignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const key = paystackSecret();
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(rawBody));
  const expected = Buffer.from(sig).toString("hex");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
