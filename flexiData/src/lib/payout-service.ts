/**
 * Provider-neutral payout service (Phase 5).
 *
 * This module defines the abstraction layer between FlexiData's withdrawal
 * lifecycle and any future real payout provider (mobile money aggregator,
 * bank transfer service, etc.). No specific provider is hardcoded.
 *
 * The service interface supports:
 *   - Creating a payout instruction
 *   - Querying payout status from the provider
 *   - Verifying provider callbacks/webhooks
 *   - Reconciling local state against provider state
 *   - Handling provider failures and timeouts
 *
 * A mock provider is available for development/testing ONLY and is explicitly
 * prevented from running in production.
 */

import type { WithdrawalAuditEvent } from "@/lib/withdrawals";

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
  /** Human-readable provider name (e.g. "mock", "paystack-payouts"). */
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
// Provider resolution
// ---------------------------------------------------------------------------

let cachedProvider: PayoutProvider | null = null;

/**
 * Get the configured payout provider.
 *
 * In development (NODE_ENV !== "production"), the mock provider is used.
 * In production, a real provider MUST be configured via PAYMENT_PROVIDER.
 *
 * The provider is cached for the lifetime of the process.
 */
export function getPayoutProvider(): PayoutProvider {
  if (cachedProvider) return cachedProvider;

  if (process.env.NODE_ENV === "production") {
    const configured = process.env.PAYOUT_PROVIDER?.trim();
    if (!configured || configured === "mock") {
      throw new Error(
        "No payout provider configured for production. " +
          "Set PAYOUT_PROVIDER to a supported provider name.",
      );
    }
    // Future: load real provider adapter here based on configured name
    throw new Error(
      `Payout provider "${configured}" is not yet implemented. ` +
        "No real payout provider is connected yet.",
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
