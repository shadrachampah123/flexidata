import "server-only";
import type { GatewayResult } from "@/lib/data-gateway";

/** Documented sandbox transport only. Customer activation is code-locked in the
 * gateway pending catalogue approval and durable settlement/reconciliation.
 * No live host, configurable URL, retries, callbacks, or raw provider messages.
 * Contract: https://docs.reloadly.com/airtime/Top-ups
 */
const BASE = "https://topups-sandbox.reloadly.com";
const AUTH = "https://auth.reloadly.com/oauth/token";
const ACCEPT = "application/com.reloadly.topups-v1+json";

export class ReloadlyConfigurationError extends Error {
  constructor() {
    super("Reloadly sandbox requires test credentials and a non-production runtime.");
    this.name = "ReloadlyConfigurationError";
  }
}

export function assertReloadlySandboxConfiguration(): void {
  if (process.env.NODE_ENV === "production" ||
      process.env.RELOADLY_MODE !== "sandbox" ||
      !process.env.RELOADLY_CLIENT_ID?.trim() ||
      !process.env.RELOADLY_CLIENT_SECRET?.trim()) {
    throw new ReloadlyConfigurationError();
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function id(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value) : null;
}

/** A timeout/invalid reply is UNKNOWN, never proof of rejection. */
async function request(url: string, init: RequestInit): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { ...init, redirect: "error", cache: "no-store", signal: controller.signal });
    return { ok: response.ok, body: object(await response.json()) };
  } catch {
    // Never echo exception messages (may contain credentials) or response bodies.
    return { ok: false, body: {} };
  } finally {
    clearTimeout(timeout);
  }
}

async function token(): Promise<string | null> {
  assertReloadlySandboxConfiguration();
  const response = await request(AUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.RELOADLY_CLIENT_ID!.trim(),
      client_secret: process.env.RELOADLY_CLIENT_SECRET!.trim(),
      grant_type: "client_credentials", audience: BASE,
    }),
  });
  return response.ok && typeof response.body.access_token === "string" && response.body.access_token.trim()
    ? response.body.access_token : null;
}

function result(reference: string | null, state: "unknown" | "accepted" | "delivered" | "rejected"): GatewayResult {
  const status = state === "delivered" ? "successful" : state === "rejected" ? "failed" : "pending";
  return {
    status, fulfillmentStatus: state === "delivered" ? "delivered" : state === "rejected" ? "failed" : "processing",
    providerCode: "reloadly", providerReference: reference, providerStatus: state,
    providerMessage: state === "unknown" ? "Provider outcome requires reconciliation; do not resubmit or refund."
      : state === "accepted" ? "Provider accepted submission; delivery is not confirmed."
      : state === "delivered" ? "Provider confirmed delivery." : "Provider confirmed rejection.",
    floatBalance: null, rawRequest: {}, rawResponse: {},
  };
}

export type ReloadlySandboxOrder = {
  reference: string;
  /** Must come from an approved Ghana DATA catalogue; never derive from label. */
  operatorId: number;
  /** Provider denomination, NOT the FlexiData retail price. */
  localAmount: number;
  recipient: string;
};

/** Only call after a durable single-winner claim. customIdentifier is a
 * reconciliation reference, NOT a documented provider idempotency guarantee.
 * This transport deliberately performs exactly one POST, without retry.
 */
export async function submitReloadlySandbox(order: ReloadlySandboxOrder): Promise<GatewayResult> {
  assertReloadlySandboxConfiguration();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(order.reference) ||
      !Number.isSafeInteger(order.operatorId) || order.operatorId <= 0 ||
      !Number.isFinite(order.localAmount) || order.localAmount <= 0 ||
      !/^233\d{9}$/.test(order.recipient)) {
    throw new Error("Invalid Reloadly sandbox order.");
  }
  const accessToken = await token();
  if (!accessToken) return result(null, "unknown");
  const response = await request(`${BASE}/topups-async`, {
    method: "POST",
    headers: { Accept: ACCEPT, "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ operatorId: order.operatorId, amount: order.localAmount,
      useLocalAmount: true, customIdentifier: order.reference,
      recipientPhone: { countryCode: "GH", number: order.recipient } }),
  });
  const reference = id(response.body.transactionId);
  // Even HTTP 200 + SUCCESSFUL on this endpoint is acceptance only.
  return result(reference, response.ok && reference ? "accepted" : "unknown");
}

/** Poll by the stored provider ID; require reference and ID correlation before
 * trusting terminal status. Unknown/unavailable statuses never trigger refund.
 */
export async function lookupReloadlySandbox(reference: string, providerReference: string): Promise<GatewayResult> {
  assertReloadlySandboxConfiguration();
  if (!/^[1-9]\d{0,15}$/.test(providerReference)) throw new Error("Invalid provider transaction identifier.");
  const accessToken = await token();
  if (!accessToken) return result(providerReference, "unknown");
  const response = await request(`${BASE}/topups/${providerReference}/status`, {
    method: "GET", headers: { Accept: ACCEPT, Authorization: `Bearer ${accessToken}` },
  });
  const transaction = object(response.body.transaction);
  if (!response.ok || id(transaction.transactionId) !== providerReference || transaction.customIdentifier !== reference) {
    return result(providerReference, "unknown");
  }
  if (response.body.status === "SUCCESSFUL" && transaction.status === "SUCCESSFUL") return result(providerReference, "delivered");
  if (response.body.status === "FAILED" && transaction.status === "FAILED") return result(providerReference, "rejected");
  return result(providerReference, "unknown");
}
