import "server-only";

/**
 * Provider-neutral payout service (Phase 5 + Phase B).
 *
 * This module defines the abstraction layer between FlexiData's withdrawal
 * lifecycle and payout providers (Paystack Transfers for real money, plus a
 * mock provider for development/testing ONLY).
 *
 * The service interface supports:
 *   - Creating a payout instruction
 *   - Querying payout status from the provider
 *   - Verifying provider callbacks/webhooks
 *   - Reconciling local state against provider state
 *   - Handling provider failures and timeouts
 *
 * SAFETY:
 *   - The mock provider is explicitly prevented from running in production.
 *   - Real Paystack transfer calls happen ONLY when the explicit production
 *     transfer flag is enabled (`PAYSTACK_TRANSFERS_ENABLED=true`) — see
 *     `src/lib/paystack-transfers.ts`. Without it, resolution fails closed.
 *   - The temporary withdrawal kill switch (`WITHDRAWALS_ENABLED`, see
 *     `src/lib/withdrawal-flag.ts`) gates `createPayout` on BOTH adapters:
 *     while it is not explicitly `true`, no payout is created — not even a
 *     simulated one. Status reads and callback verification stay available so
 *     historical records keep reconciling while payouts are paused.
 */

import type { WithdrawalAuditEvent } from "@/lib/withdrawals";
import {
  createMomoRecipient,
  fetchTransfer,
  initiateTransfer,
  isPaystackTransfersEnabled,
  mapPaystackTransferStatus,
  payoutCedisToPesewas,
  PAYOUT_CURRENCY,
  PaystackTransferAmbiguousError,
  PaystackTransferValidationError,
} from "@/lib/paystack-transfers";
import { isValidPaystackWebhookSignature } from "@/lib/paystack";
import { pesewasToCedisString } from "@/lib/money";
import type { WithdrawalMethod } from "@/lib/ghana-mobile";
import { assertWithdrawalsEnabled } from "@/lib/withdrawal-flag";

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/** The outcome a provider can report for a payout. */
export type PayoutOutcome = "successful" | "failed" | "pending" | "reversed";

/** Data returned when a payout is created with the provider. */
export type CreatePayoutResult = {
  /** The provider's own reference for this payout. */
  providerReference: string;
  /** Initial status reported by the provider. */
  status: PayoutOutcome;
  /** Optional human-readable message from the provider. */
  message?: string;
  /** Raw provider response (for audit trail; no secrets). */
  rawPayload?: Record<string, unknown>;
};

/** Data returned when querying a payout's status. */
export type PayoutStatusResult = {
  providerReference: string;
  status: PayoutOutcome;
  message?: string;
  /** When the provider last updated this payout. */
  updatedAt?: Date;
  /** Amount the provider reports (canonical cedis string, for verification). */
  amount?: string;
  /** Currency the provider reports (for verification). */
  currency?: string;
  rawPayload?: Record<string, unknown>;
};

/** Parameters for creating a payout. */
export type CreatePayoutParams = {
  /** FlexiData withdrawal reference (our internal tracking). */
  withdrawalRef: string;
  /** Exact amount in cedis (e.g. "5.00"). Never trust client input. */
  amount: string;
  /** Currency code (always "GHS" for now). */
  currency: string;
  /** Withdrawal method (e.g. "momo_mtn"). */
  method: string;
  /** Normalized destination MSISDN (e.g. "0244123456"). */
  destination: string;
  /** Network name (e.g. "MTN"). */
  network: string;
  /**
   * Previously created recipient code (RCP_…), when the caller already
   * persisted one for this withdrawal. Reused verbatim so a retry never
   * creates a duplicate recipient.
   */
  recipientCode?: string | null;
  /** Server-derived account holder name for recipient creation. */
  accountName?: string;
};

/** Parsed callback/webhook data from a provider. */
export type ProviderCallbackData = {
  /** The provider's reference for this payout. */
  providerReference: string;
  /** The reported outcome. */
  status: PayoutOutcome;
  /** Amount the provider says was sent (for verification). */
  amount?: string;
  /** Currency the provider reports (for verification). */
  currency?: string;
  /** Human-readable message from the provider. */
  message?: string;
  /**
   * Our own stable reference echoed back by the provider (the withdrawal ref
   * for Paystack transfers). Used ONLY as a fallback lookup when the
   * provider_reference has not been stored yet (webhook/provider race) — never
   * trusted for amount, user or wallet.
   */
  withdrawalRef?: string;
  /**
   * True for a structurally valid, correctly signed callback the payout
   * lifecycle intentionally ignores (e.g. a non-transfer Paystack event).
   * The route must ack it with 200 and perform NO state change.
   */
  ignored?: boolean;
  /** Raw callback payload (for audit; no secrets). */
  rawPayload?: Record<string, unknown>;
};

/** Result of verifying a callback. */
export type CallbackVerificationResult =
  | { ok: true; data: ProviderCallbackData }
  | { ok: false; error: string };

/**
 * The provider interface. Each method is designed to be implemented by a
 * specific provider adapter (Paystack Payouts, Hubtel, NombaPay, etc.).
 *
 * Implementations MUST:
 *   - Never store or log provider secrets
 *   - Return provider references (not internal IDs) in results
 *   - Report honest statuses (no fabricating successes)
 */
export interface PayoutProvider {
  /** Human-readable provider name (e.g. "mock", "paystack-transfers"). */
  readonly name: string;

  /**
   * Submit a payout instruction to the provider.
   * Returns the provider's reference and initial status.
   * MUST NOT mark anything as successful without provider confirmation.
   */
  createPayout(params: CreatePayoutParams): Promise<CreatePayoutResult>;

  /**
   * Query the current status of a payout from the provider.
   * Used for reconciliation and manual status checks.
   */
  getPayoutStatus(providerReference: string): Promise<PayoutStatusResult | null>;

  /**
   * Verify a callback/webhook signature and extract payout data.
   * MUST reject invalid signatures.
   * MUST NOT trust amount/user/wallet data from the callback body.
   */
  verifyCallback(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<CallbackVerificationResult>;
}

// ---------------------------------------------------------------------------
// Mock provider (development/testing only)
// ---------------------------------------------------------------------------

/**
 * Mock payout provider for development and testing.
 *
 * SAFETY: This provider MUST NEVER run in production. It simulates payouts
 * without sending real money. The `assertNotProduction()` guard prevents
 * accidental use.
 */
class MockPayoutProvider implements PayoutProvider {
  readonly name = "mock";

  private assertNotProduction(): void {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Mock payout provider cannot be used in production. " +
          "Configure a real payout provider (PAYMENT_PROVIDER env var).",
      );
    }
  }

  async createPayout(params: CreatePayoutParams): Promise<CreatePayoutResult> {
    this.assertNotProduction();
    // Temporary kill switch: no payout — not even a simulated one — while
    // WITHDRAWALS_ENABLED is not explicitly true.
    assertWithdrawalsEnabled();
    // Simulate a provider reference and pending status
    const providerReference = `MOCK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    return {
      providerReference,
      status: "pending",
      message: "Mock payout created (no real money sent)",
      rawPayload: {
        mock: true,
        method: params.method,
        destination: params.destination,
        amount: params.amount,
      },
    };
  }

  async getPayoutStatus(providerReference: string): Promise<PayoutStatusResult | null> {
    this.assertNotProduction();
    // Mock always returns pending (simulates waiting for provider confirmation)
    return {
      providerReference,
      status: "pending",
      message: "Mock payout status (no real provider)",
    };
  }

  async verifyCallback(
    rawBody: string,
    _headers: Record<string, string | string[] | undefined>,
  ): Promise<CallbackVerificationResult> {
    this.assertNotProduction();
    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      const providerReference = payload.provider_reference;
      if (typeof providerReference !== "string" || !providerReference.startsWith("MOCK-")) {
        return { ok: false, error: "Invalid mock provider reference" };
      }
      return {
        ok: true,
        data: {
          providerReference,
          status: (payload.status as PayoutOutcome) || "successful",
          amount: typeof payload.amount === "string" ? payload.amount : undefined,
          currency: typeof payload.currency === "string" ? payload.currency : undefined,
          message: typeof payload.message === "string" ? payload.message : undefined,
          rawPayload: payload,
        },
      };
    } catch {
      return { ok: false, error: "Invalid callback payload" };
    }
  }
}

// ---------------------------------------------------------------------------
// Paystack Transfers provider (Phase B — real money)
// ---------------------------------------------------------------------------

/**
 * Paystack Transfer payout provider.
 *
 * Real-money adapter with the same fail-closed posture as the deposit side:
 *
 *  - Every call asserts `isPaystackTransfersEnabled()` FIRST (explicit
 *    `PAYSTACK_TRANSFERS_ENABLED=true` + configured secret key with the
 *    live-mode lock). Without the flag, creation/status/callback verification
 *    all refuse before any network I/O.
 *  - `createPayout` sends the withdrawal ref as Paystack's stable `reference`
 *    (reused verbatim on retry — never regenerated), converts GHS to integer
 *    pesewas exactly, validates the recipient server-side, and persists the
 *    returned recipient code in `rawPayload` for the caller to store.
 *  - Ambiguous outcomes (timeout/network, or Paystack reporting the reference
 *    as already used) propagate as `PaystackTransferAmbiguousError` so the
 *    caller keeps the SAME reference instead of forking a second transfer.
 *  - `verifyCallback` REQUIRES a valid Paystack HMAC-SHA512 signature and only
 *    honours `transfer.success` / `transfer.failed` / `transfer.reversed`.
 *    Anything else signed-but-unsupported is marked `ignored` (ack, no state
 *    change) so provider retries cannot wedge the endpoint.
 */
class PaystackTransferProvider implements PayoutProvider {
  readonly name = "paystack-transfers";

  private assertEnabled(): void {
    if (!isPaystackTransfersEnabled()) {
      throw new PaystackTransferValidationError(
        "Paystack transfers are disabled. Set PAYSTACK_TRANSFERS_ENABLED=true to enable real payouts.",
      );
    }
  }

  async createPayout(params: CreatePayoutParams): Promise<CreatePayoutResult> {
    // Temporary kill switch FIRST: while WITHDRAWALS_ENABLED is not
    // explicitly true, no recipient is created and no transfer is initiated —
    // before the transfers-flag check and before any network I/O.
    assertWithdrawalsEnabled();
    this.assertEnabled();

    if ((params.currency || "").toUpperCase() !== PAYOUT_CURRENCY) {
      throw new PaystackTransferValidationError(
        `Unsupported payout currency "${params.currency}" (expected ${PAYOUT_CURRENCY}).`,
      );
    }
    // Exact GHS → pesewas (integer arithmetic only — never floats).
    const amountPesewas = payoutCedisToPesewas(params.amount);

    const method = params.method as WithdrawalMethod;
    if (method !== "momo_mtn" && method !== "telecel_cash") {
      throw new PaystackTransferValidationError(`Unsupported payout method "${params.method}".`);
    }

    // Reuse a previously persisted recipient code so a retry never creates a
    // duplicate recipient; otherwise create one (server-side validation inside).
    let recipientCode = (params.recipientCode ?? "").trim();
    let recipientCreated = false;
    if (!recipientCode) {
      const recipient = await createMomoRecipient({
        method,
        destination: params.destination,
        accountName: params.accountName?.trim() || "FlexiData customer",
      });
      recipientCode = recipient.recipientCode;
      recipientCreated = true;
    }

    // The withdrawal ref IS the stable Paystack reference (reused verbatim on
    // every retry of this withdrawal — never regenerated).
    const initiated = await initiateTransfer({
      amountPesewas,
      recipientCode,
      reference: params.withdrawalRef,
      reason: `FlexiData withdrawal ${params.withdrawalRef}`,
    });

    return {
      providerReference: initiated.transferCode,
      status: mapPaystackTransferStatus(initiated.rawStatus),
      message:
        initiated.rawStatus.toLowerCase() === "otp"
          ? "Paystack transfer created; awaiting OTP finalization in the Paystack dashboard"
          : `Paystack transfer ${initiated.transferCode} (${initiated.rawStatus})`,
      rawPayload: {
        provider: "paystack-transfers",
        transfer_code: initiated.transferCode,
        reference: initiated.reference,
        recipient_code: recipientCode,
        recipient_created: recipientCreated,
        amount_pesewas: amountPesewas,
        currency: PAYOUT_CURRENCY,
        raw_status: initiated.rawStatus,
      },
    };
  }

  async getPayoutStatus(providerReference: string): Promise<PayoutStatusResult | null> {
    this.assertEnabled();
    const code = providerReference.trim();
    if (!code) return null;
    const fetched = await fetchTransfer(code);
    return {
      providerReference: fetched.transferCode,
      status: mapPaystackTransferStatus(fetched.rawStatus),
      message: `Paystack transfer ${fetched.rawStatus}`,
      amount:
        fetched.amountPesewas !== null ? pesewasToCedisString(fetched.amountPesewas) : undefined,
      currency: fetched.currency ?? undefined,
      rawPayload: {
        provider: "paystack-transfers",
        transfer_code: fetched.transferCode,
        reference: fetched.reference,
        raw_status: fetched.rawStatus,
        amount_pesewas: fetched.amountPesewas,
        currency: fetched.currency,
        recipient_code: fetched.recipientCode,
      },
    };
  }

  async verifyCallback(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<CallbackVerificationResult> {
    this.assertEnabled();
    // Signature is MANDATORY. Header lookup is case-insensitive.
    let signature: string | null = null;
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "x-paystack-signature") {
        signature = Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
        break;
      }
    }
    if (!isValidPaystackWebhookSignature(rawBody, signature)) {
      return { ok: false, error: "Invalid Paystack webhook signature" };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "Invalid callback payload" };
    }
    const event = typeof payload.event === "string" ? payload.event : "";
    const data = (payload.data ?? {}) as Record<string, unknown>;

    // Only transfer lifecycle events move money. Anything else signed-but-
    // unsupported is acked-and-ignored (no state change, no exception).
    if (event !== "transfer.success" && event !== "transfer.failed" && event !== "transfer.reversed") {
      return {
        ok: true,
        data: {
          providerReference: typeof data.transfer_code === "string" ? data.transfer_code : "",
          status: "pending",
          message: `Ignored Paystack event "${event || "unknown"}"`,
          ignored: true,
          rawPayload: { event },
        },
      };
    }

    const transferCode = typeof data.transfer_code === "string" ? data.transfer_code.trim() : "";
    if (!transferCode) {
      return { ok: false, error: "Paystack transfer callback is missing transfer_code" };
    }
    const status: PayoutOutcome =
      event === "transfer.success" ? "successful" : event === "transfer.failed" ? "failed" : "reversed";

    // Amount: Paystack reports integer kobo/pesewas. Anything else is refused
    // (the route then skips amount verification rather than comparing floats).
    const rawAmount = data.amount;
    const amountPesewas =
      typeof rawAmount === "number" && Number.isInteger(rawAmount) && rawAmount >= 0
        ? rawAmount
        : null;

    return {
      ok: true,
      data: {
        providerReference: transferCode,
        status,
        amount: amountPesewas !== null ? pesewasToCedisString(amountPesewas) : undefined,
        currency: typeof data.currency === "string" ? data.currency : undefined,
        message:
          typeof data.status === "string"
            ? `Paystack ${event} (${data.status})`
            : `Paystack ${event}`,
        withdrawalRef: typeof data.reference === "string" ? data.reference : undefined,
        rawPayload: {
          provider: "paystack-transfers",
          event,
          transfer_code: transferCode,
          reference: typeof data.reference === "string" ? data.reference : null,
          raw_status: typeof data.status === "string" ? data.status : null,
          amount_pesewas: amountPesewas,
          currency: typeof data.currency === "string" ? data.currency : null,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

let cachedProvider: PayoutProvider | null = null;

/**
 * Get the configured payout provider.
 *
 * Resolution (fail-closed in production):
 *   - `PAYOUT_PROVIDER=paystack-transfers` (or `paystack`) + transfers enabled
 *     → the real Paystack Transfer adapter.
 *   - production + anything else (unset, `mock`, transfers disabled) → throws.
 *     The mock provider can NEVER run in production.
 *   - non-production + unset/other → the mock provider (dev/test aid).
 *
 * The provider is cached for the lifetime of the process.
 */
export function getPayoutProvider(): PayoutProvider {
  if (cachedProvider) return cachedProvider;

  const configured = (process.env.PAYOUT_PROVIDER ?? "").trim().toLowerCase();
  const wantsPaystack = configured === "paystack-transfers" || configured === "paystack";

  if (wantsPaystack) {
    if (!isPaystackTransfersEnabled()) {
      throw new PaystackTransferValidationError(
        "Paystack payouts are not enabled. Set PAYSTACK_TRANSFERS_ENABLED=true (and configure PAYSTACK_SECRET_KEY) to use the paystack-transfers provider.",
      );
    }
    cachedProvider = new PaystackTransferProvider();
    return cachedProvider;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "No payout provider configured for production. " +
        "Set PAYOUT_PROVIDER=paystack-transfers and PAYSTACK_TRANSFERS_ENABLED=true to enable real payouts.",
    );
  }

  // Development/testing: use the mock provider
  cachedProvider = new MockPayoutProvider();
  return cachedProvider;
}

/**
 * Reset the cached provider (for testing only).
 */
export function resetPayoutProvider(): void {
  cachedProvider = null;
}

/**
 * Check if a real payout provider is connected (vs mock).
 */
export function isRealPayoutProviderConnected(): boolean {
  try {
    const provider = getPayoutProvider();
    return provider.name !== "mock";
  } catch {
    return false;
  }
}

export { PaystackTransferAmbiguousError };
export type { WithdrawalAuditEvent };
