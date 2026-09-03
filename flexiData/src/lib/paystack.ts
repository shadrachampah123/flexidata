import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Server-only Paystack client.
 *
 * Every Paystack call in FlexiData goes through this module so that:
 *
 *  - The secret key is read from `process.env.PAYSTACK_SECRET_KEY` in exactly
 *    one place, is never logged, never serialised into an error message and
 *    never leaves the server (the `server-only` import makes a client-side
 *    import a build error).
 *  - TEST vs LIVE mode is purely a configuration concern: the mode is derived
 *    from the key prefix (`sk_test_` / `sk_live_`). As a safety lock, a LIVE
 *    key is refused unless `PAYSTACK_LIVE_MODE=true` is also set, so swapping
 *    the environment variables is a deliberate two-step action and can never
 *    happen by accident. No code changes are needed to go live.
 *  - Webhook signatures are verified with a constant-time comparison.
 *
 * The public key (PAYSTACK_PUBLIC_KEY) is intentionally unused: the redirect
 * (authorization URL) flow only needs the secret key, so nothing key-related
 * ever has to reach the browser.
 */

const DEFAULT_BASE_URL = "https://api.paystack.co";

/** Currency every FlexiData order is priced and verified in. */
export const PAYSTACK_CURRENCY = "GHS";

export class PaystackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaystackConfigError";
  }
}

export class PaystackRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaystackRequestError";
  }
}

function envBool(key: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[key] ?? "").trim().toLowerCase());
}

/**
 * Base URL for the Paystack API. Overridable only so automated tests can point
 * the app at a local stub; defaults to the real API. (Paystack uses the same
 * host for test and live — the key decides the mode.)
 */
function paystackBaseUrl(): string {
  return (process.env.PAYSTACK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

/** True when a Paystack secret key is configured (test or live). */
export function isPaystackConfigured(): boolean {
  return Boolean(process.env.PAYSTACK_SECRET_KEY?.trim());
}

/** "test" | "live" for display/telemetry. Never returns key material. */
export function paystackMode(): "test" | "live" | "unconfigured" {
  const key = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!key) return "unconfigured";
  return key.startsWith("sk_live_") ? "live" : "test";
}

/**
 * The one accessor for the secret key. Throws a config error (with no key
 * material in the message) when missing, and refuses to operate with a LIVE
 * key unless the deployment explicitly opts in via PAYSTACK_LIVE_MODE=true.
 */
function paystackSecretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!key) {
    throw new PaystackConfigError(
      "Paystack is not configured on the server. Set PAYSTACK_SECRET_KEY in the environment.",
    );
  }
  if (key.startsWith("sk_live_") && !envBool("PAYSTACK_LIVE_MODE")) {
    // TEST-MODE lock: a live key can only be used after an explicit,
    // deliberate opt-in. This is what keeps the integration test-only today
    // while making the eventual live switch a pure configuration change.
    throw new PaystackConfigError(
      "A LIVE Paystack key is configured but PAYSTACK_LIVE_MODE is not enabled. " +
        "This deployment is locked to TEST mode; set PAYSTACK_LIVE_MODE=true only when you intend to charge real money.",
    );
  }
  return key;
}

/** Parse a response body without ever throwing on non-JSON payloads. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await res.json()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Paystack error surface that is safe to log and to show to API consumers:
 * only Paystack's own public `message` field plus the HTTP status — never
 * headers, never the request we sent, never key material.
 */
function requestError(context: string, status: number | null, message: unknown): PaystackRequestError {
  const detail = typeof message === "string" && message.trim() ? `: ${message.trim()}` : "";
  const suffix = status ? ` (HTTP ${status})` : "";
  return new PaystackRequestError(`${context} failed${suffix}${detail}`);
}

async function paystackFetch(path: string, init: RequestInit, context: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${paystackBaseUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${paystackSecretKey()}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof PaystackConfigError) throw error;
    // Network-level failure: no response, nothing sensitive to leak.
    throw requestError(context, null, "could not reach Paystack");
  }

  const body = await readJson(res);
  if (!res.ok || body.status !== true) {
    throw requestError(context, res.status, body.message);
  }
  return body;
}

export type PaystackInitResult = {
  reference: string;
  authorizationUrl: string;
  accessCode: string | null;
};

/**
 * Initialize a transaction (server-side, secret key). `amountSubunits` is in
 * pesewas — callers must pass the integer amount they later expect
 * verification to return, never a float.
 */
export async function paystackInitializeTransaction(params: {
  reference: string;
  amountSubunits: number;
  email: string;
  /**
   * Where Paystack sends the browser after the customer pays. Optional: when
   * the deployment has no determinable public URL we omit it rather than send a
   * link nobody can open (Paystack then shows its own receipt and the webhook
   * still settles the charge).
   */
  callbackUrl?: string | null;
  channels?: string[];
  metadata?: Record<string, unknown>;
}): Promise<PaystackInitResult> {
  if (!Number.isInteger(params.amountSubunits) || params.amountSubunits <= 0) {
    throw new PaystackRequestError("Invalid charge amount.");
  }

  const body = await paystackFetch(
    "/transaction/initialize",
    {
      method: "POST",
      body: JSON.stringify({
        reference: params.reference,
        amount: params.amountSubunits,
        currency: PAYSTACK_CURRENCY,
        email: params.email,
        ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {}),
        ...(params.channels?.length ? { channels: params.channels } : {}),
        metadata: params.metadata ?? {},
      }),
    },
    "Payment initialization",
  );

  const data = (body.data ?? {}) as Record<string, unknown>;
  const authorizationUrl = typeof data.authorization_url === "string" ? data.authorization_url : null;
  if (!authorizationUrl) {
    throw new PaystackRequestError("Payment initialization failed: Paystack returned no checkout URL.");
  }
  return {
    reference: typeof data.reference === "string" ? data.reference : params.reference,
    authorizationUrl,
    accessCode: typeof data.access_code === "string" ? data.access_code : null,
  };
}

export type PaystackVerification = {
  /** Normalised transaction state. */
  status: "success" | "failed" | "abandoned" | "pending" | "reversed";
  /** Paystack's raw status string, for the audit trail. */
  rawStatus: string;
  reference: string | null;
  /** Amount actually charged, in subunits (pesewas). */
  amountSubunits: number | null;
  currency: string | null;
  transactionId: string | null;
  channel: string | null;
  paidAt: Date | null;
  gatewayResponse: string | null;
};

function normalizeVerifyStatus(raw: string): PaystackVerification["status"] {
  const s = raw.toLowerCase();
  if (s === "success") return "success";
  if (s === "failed") return "failed";
  if (s === "abandoned") return "abandoned";
  if (s === "reversed" || s === "refunded" || s === "chargeback") return "reversed";
  // ongoing / pending / processing / queued / send_otp / anything unknown:
  // treat as "not paid yet" and never as success.
  return "pending";
}

/**
 * Verify a transaction directly with Paystack (GET /transaction/verify/:ref).
 * This is the ONLY source of truth for "the customer has paid" — webhook
 * payloads and browser redirects are treated as hints, never as proof.
 */
export async function paystackVerifyTransaction(reference: string): Promise<PaystackVerification> {
  const body = await paystackFetch(
    `/transaction/verify/${encodeURIComponent(reference)}`,
    { method: "GET" },
    "Payment verification",
  );

  const data = (body.data ?? {}) as Record<string, unknown>;
  const rawStatus = typeof data.status === "string" ? data.status : "unknown";
  const amount = typeof data.amount === "number" && Number.isFinite(data.amount) ? data.amount : null;
  const paidAtRaw = typeof data.paid_at === "string" ? data.paid_at : null;
  const paidAt = paidAtRaw ? new Date(paidAtRaw) : null;

  return {
    status: normalizeVerifyStatus(rawStatus),
    rawStatus,
    reference: typeof data.reference === "string" ? data.reference : null,
    amountSubunits: amount,
    currency: typeof data.currency === "string" ? data.currency : null,
    transactionId:
      typeof data.id === "number" || typeof data.id === "string" ? String(data.id) : null,
    channel: typeof data.channel === "string" ? data.channel : null,
    paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
    gatewayResponse: typeof data.gateway_response === "string" ? data.gateway_response : null,
  };
}

/**
 * Verify Paystack's `x-paystack-signature` header: HMAC-SHA512 of the raw
 * request body keyed with the secret key, compared in constant time.
 */
export function isValidPaystackWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!signature || !isPaystackConfigured()) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(createHmac("sha512", paystackSecretKey()).update(rawBody).digest("hex"), "utf8");
  } catch {
    // Config error (e.g. live key without the live-mode opt-in): reject.
    return false;
  }
  const provided = Buffer.from(signature, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
