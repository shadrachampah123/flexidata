
/**
 * Wallet funding gateway.
 *
 * - `paystack` (the default whenever `PAYSTACK_SECRET_KEY` is configured): real
 *   Ghanaian mobile-money / card checkout on Paystack's hosted page. The wallet
 *   is only credited after Paystack verifies the payment server-side (see
 *   /api/payments/verify and /api/payments/webhook → `src/lib/deposits.ts`).
 * - `mock` (opt-in via `PAYMENTS_PROVIDER=mock`, and the fallback when no
 *   Paystack key exists): mobile money is simulated server-side and the wallet
 *   is credited immediately. No real payment is taken — it is a development /
 *   demo aid only, which is why it can never be the default on a deployment
 *   that has configured Paystack.
 *
 * The secret key is read only inside `src/lib/paystack.ts` (`server-only`); this
 * module and everything that calls it never sees it and never sends anything
 * key-related to the browser.
 */

import {
  isPaystackConfigured,
  isValidPaystackWebhookSignature,
  paystackInitializeTransaction,
  paystackMode,
  paystackVerifyTransaction,
} from "@/lib/paystack";
import { resolveAppBaseUrl } from "@/lib/notifications";

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

/**
 * Which gateway funds the wallet.
 *
 *  - `PAYMENTS_PROVIDER=paystack` → Paystack.
 *  - `PAYMENTS_PROVIDER=mock`     → the local simulator (explicit opt-in).
 *  - unset / unrecognised         → Paystack when a secret key is configured,
 *    otherwise the simulator (so a fresh local checkout with no keys still
 *    funds a wallet for development).
 *
 * Deriving the default from the key is deliberate: the simulator credits a
 * wallet with no money moving, so a deployment that has gone to the trouble of
 * configuring Paystack must never silently fall back to it. That fallback is
 * what made the deposit button look like an instant "MTN MoMo" top-up.
 */
let mockOverrideWarned = false;

export function paymentsProvider(): "mock" | "paystack" {
  const configured = (process.env.PAYMENTS_PROVIDER ?? "").trim().toLowerCase();

  if (configured === "paystack") return "paystack";

  if (configured === "mock") {
    // Loud, once per serverless instance: a mock override next to a real
    // Paystack key is almost always a leftover environment variable, and it
    // means deposits are being simulated instead of charged.
    if (!mockOverrideWarned && isPaystackConfigured()) {
      mockOverrideWarned = true;
      console.warn(
        "[flexidata] wallet funding is in MOCK mode (PAYMENTS_PROVIDER=mock) while PAYSTACK_SECRET_KEY is set — " +
          "deposits are simulated and credit the wallet without a real payment. " +
          'Remove PAYMENTS_PROVIDER (or set it to "paystack") to charge through Paystack.',
      );
    }
    return "mock";
  }

  return isPaystackConfigured() ? "paystack" : "mock";
}

/**
 * Public base URL for the Paystack callback, using the project's canonical
 * resolver (`resolveAppBaseUrl`, the same one password-reset links use):
 *
 *   `APP_BASE_URL` / `NEXT_PUBLIC_APP_URL` → the origin of the incoming request
 *   → `VERCEL_URL` → localhost (development only), with a loopback
 *   `APP_BASE_URL` ignored in production.
 *
 * Two failure modes this avoids, both of which leave a customer who has just
 * paid staring at a dead end:
 *   - `APP_BASE_URL` never set on Vercel → the old code hard-coded
 *     `http://localhost:3000`, sending the browser to the customer's own
 *     machine, so the wallet page could never verify the charge.
 *   - `APP_BASE_URL` copied from `.env.example` as a localhost value → ignored
 *     in production, the request origin wins instead.
 *
 * It returns `null` only when a production deployment has no determinable
 * public URL; we then send Paystack no `callback_url` at all rather than a link
 * nobody can open. Paystack shows its own receipt and the webhook still settles
 * the deposit server-side.
 */
function depositCallbackUrl(ref: string, requestOrigin?: string | null): string | null {
  const base = resolveAppBaseUrl(requestOrigin);
  if (!base) return null;
  return `${base}/wallet?funding=success&ref=${encodeURIComponent(ref)}`;
}

/**
 * Paystack channels offered for a deposit method.
 *
 * The customer actually picks MTN / Telecel / card on Paystack's own page, so
 * `mobile_money` covers both MoMo methods and `card` covers the card method.
 *
 * In TEST mode `card` is added alongside `mobile_money`: mobile money is not
 * enabled on every Paystack test account (the checkout then fails with
 * "No active channel to process transaction"), and a test deposit must always
 * be completable — Paystack's test card is the documented way to do that.
 * LIVE mode keeps the strict single-channel mapping.
 */
function depositChannels(method: PaymentMethod): string[] {
  if (PAYMENT_METHODS[method].channel === "card") return ["card"];
  return paystackMode() === "test" ? ["mobile_money", "card"] : ["mobile_money"];
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
  /**
   * Mobile-money number the customer typed in the funding form. It is a HINT
   * recorded in the Paystack metadata only — Paystack's hosted checkout is what
   * actually collects and debits a mobile-money wallet, and the wallet that gets
   * credited is always the signed-in user's own (resolved server-side).
   */
  momoNumber?: string | null;
  /** Origin of the API request — the callback-URL fallback (see depositCallbackUrl). */
  requestOrigin?: string | null;
}): Promise<InitPaymentResult> {
  const provider = paymentsProvider();

  if (provider === "mock") {
    // Simulated MoMo/card settlement: instant success, deterministic ref.
    return { status: "completed", providerRef: `mock-${params.ref}`, authorizationUrl: null };
  }

  const momoNumber = (params.momoNumber ?? "").replace(/\D/g, "").slice(0, 15);

  // --- Paystack (shared server-only client: secret key never leaves it) ---
  const init = await paystackInitializeTransaction({
    reference: params.ref,
    // Integer minor units (pesewas) — never a float, and always the same
    // integer that verification is later required to match exactly.
    amountSubunits: Math.round(params.amountGhs * 100),
    email: params.email,
    callbackUrl: depositCallbackUrl(params.ref, params.requestOrigin),
    channels: depositChannels(params.method),
    metadata: {
      app: "flexidata",
      kind: "wallet_deposit",
      method: params.method,
      phone: params.phone,
      ...(momoNumber ? { momo_number: momoNumber } : {}),
      custom_fields: [
        {
          display_name: "Deposit",
          variable_name: "wallet_deposit",
          value: `Wallet top-up (${PAYMENT_METHODS[params.method].label})`,
        },
        ...(momoNumber
          ? [{ display_name: "MoMo number", variable_name: "momo_number", value: momoNumber }]
          : []),
      ],
    },
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
