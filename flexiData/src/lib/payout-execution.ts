import "server-only";

import { eq } from "drizzle-orm";
import { withdrawalRequests } from "@/db/schema";
import { getPayoutProvider } from "@/lib/payout-service";
import {
  PaystackTransferAmbiguousError,
} from "@/lib/paystack-transfers";
import { recordWithdrawalEvent } from "@/lib/withdrawal-audit";
import { assertWithdrawalsEnabled } from "@/lib/withdrawal-flag";

/**
 * Payout execution — the single choke point that submits a withdrawal to the
 * configured payout provider (Phase B).
 *
 * Called from the admin withdrawal API at approve time (pending → processing)
 * and on explicit admin retry (processing → processing). It NEVER moves money
 * itself: the wallet was already debited at request creation, and this step
 * only instructs the provider to pay out the NET amount.
 *
 * Idempotency contract (every path):
 *   - The withdrawal ref is the stable provider reference, reused verbatim on
 *     every retry — never regenerated.
 *   - If the withdrawal already carries a `provider_reference`, NO new
 *     transfer is created: the existing transfer is re-queried and its status
 *     is converged locally (a retry can never create a second transfer).
 *   - Ambiguous provider outcomes (timeout / network failure / "reference
 *     already used") never mint a new reference: the withdrawal stays in
 *     `processing` under the same reference with `provider_status = 'unknown'`
 *     until reconciliation resolves it.
 *   - A previously persisted recipient code is reused, so a retry never
 *     creates a duplicate recipient either.
 */

export type PayoutAttemptOutcome =
  | "initiated"
  | "reused"
  | "skipped_no_provider"
  | "ambiguous"
  | "failed";

export type PayoutAttemptResult = {
  attempted: boolean;
  outcome: PayoutAttemptOutcome;
  providerReference: string | null;
  /** Safe, operator-facing summary (no secrets, no key material). */
  message: string;
};

export type PayoutActor =
  | { type: "admin"; id: number; email: string }
  | { type: "system" };

type WithdrawalRow = typeof withdrawalRequests.$inferSelect;

function clampText(value: string | null | undefined, max = 240): string | null {
  if (!value) return null;
  const s = value.trim();
  if (s === "") return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function readDestination(withdrawal: WithdrawalRow): { msisdn: string; network: string } {
  const details = (withdrawal.destinationDetails ?? {}) as Record<string, unknown>;
  return {
    msisdn: typeof details.account === "string" ? details.account : "",
    network: typeof details.network === "string" ? details.network : "",
  };
}

function readStoredRecipientCode(withdrawal: WithdrawalRow): string | null {
  const payload = (withdrawal.providerPayload ?? {}) as Record<string, unknown>;
  const direct = payload.recipient_code;
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  return null;
}

function mergePayload(
  existing: unknown,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, ...extra };
}

/**
 * Submit a `processing` withdrawal to the payout provider (or converge the
 * existing provider transfer). MUST be called with the withdrawal row locked
 * (`SELECT … FOR UPDATE`) inside the caller's transaction — all writes here
 * commit atomically with the caller's status change.
 */
export async function executeWithdrawalPayout(
  // The caller's Drizzle transaction (same `tx: any` convention as
  // `recordWithdrawalEvent`): updates + audit rows commit atomically.
  tx: any,
  withdrawal: WithdrawalRow,
  actor: PayoutActor,
  opts?: { accountName?: string },
): Promise<PayoutAttemptResult> {
  // Temporary kill switch (fail-closed): while WITHDRAWALS_ENABLED is not
  // explicitly true, NO payout may execute — refused here, before any status
  // check, provider resolution, or network I/O, on EVERY path (initiate,
  // reuse/re-check, retry). The caller's transaction rolls back with this
  // throw, so the withdrawal row is left exactly as it was.
  assertWithdrawalsEnabled();

  if (withdrawal.status !== "processing") {
    throw new Error(`executeWithdrawalPayout requires status=processing (has ${withdrawal.status})`);
  }

  const actorFields =
    actor.type === "admin"
      ? { actorType: "admin" as const, actorId: actor.id, actorEmail: actor.email }
      : { actorType: "system" as const, actorId: null, actorEmail: null };

  // --- Path 1: a transfer already exists → NEVER create another one. ------
  if (withdrawal.providerReference) {
    let message = `Transfer ${withdrawal.providerReference} already initiated; re-checked provider status`;
    let providerStatus = withdrawal.providerStatus ?? "pending";
    try {
      const provider = getPayoutProvider();
      const status = await provider.getPayoutStatus(withdrawal.providerReference);
      if (status) {
        providerStatus = status.status;
        message = status.message || message;
        await tx
          .update(withdrawalRequests)
          .set({
            providerStatus: status.status,
            providerMessage: clampText(status.message),
            providerPayload: mergePayload(withdrawal.providerPayload, {
              ...(status.rawPayload ?? {}),
              last_status_check_at: new Date().toISOString(),
            }),
            updatedAt: new Date(),
          })
          .where(eq(withdrawalRequests.id, withdrawal.id));
      }
    } catch (error) {
      // Status re-check is best-effort: the transfer exists either way, so a
      // failed re-check must not fail the retry — just record what happened.
      message = `Transfer ${withdrawal.providerReference} already initiated; status re-check failed (${(error as Error)?.message ?? "unknown error"})`;
    }
    await recordWithdrawalEvent(tx, {
      withdrawalId: withdrawal.id,
      withdrawalRef: withdrawal.ref,
      event: "moved_to_processing",
      previousStatus: "processing",
      newStatus: "processing",
      ...actorFields,
      providerReference: withdrawal.providerReference,
      reason: clampText(message, 240),
      metadata: { retry: true, reused_transfer: true },
    });
    return {
      attempted: true,
      outcome: "reused",
      providerReference: withdrawal.providerReference,
      message,
    };
  }

  // --- Path 2: resolve the provider (fail-open to manual payout). ---------
  let provider: ReturnType<typeof getPayoutProvider>;
  try {
    provider = getPayoutProvider();
  } catch (error) {
    const message = `No payout provider configured (${(error as Error)?.message ?? "unknown"}); withdrawal awaits manual payout or retry`;
    await tx
      .update(withdrawalRequests)
      .set({
        providerStatus: "awaiting_provider",
        providerMessage: clampText(message),
        updatedAt: new Date(),
      })
      .where(eq(withdrawalRequests.id, withdrawal.id));
    await recordWithdrawalEvent(tx, {
      withdrawalId: withdrawal.id,
      withdrawalRef: withdrawal.ref,
      event: "moved_to_processing",
      previousStatus: "processing",
      newStatus: "processing",
      ...actorFields,
      reason: clampText(message, 240),
      metadata: { payout_skipped: true, reason: "no_provider" },
    });
    return { attempted: false, outcome: "skipped_no_provider", providerReference: null, message };
  }

  // --- Path 3: initiate under the STABLE reference (the withdrawal ref). ---
  const { msisdn, network } = readDestination(withdrawal);
  try {
    const created = await provider.createPayout({
      withdrawalRef: withdrawal.ref,
      amount: String(withdrawal.netAmount),
      currency: withdrawal.currency || "GHS",
      method: withdrawal.destinationMethod,
      destination: msisdn,
      network,
      recipientCode: readStoredRecipientCode(withdrawal),
      accountName: opts?.accountName,
    });

    const payload = mergePayload(withdrawal.providerPayload, {
      ...(created.rawPayload ?? {}),
      // Flattened for cheap reuse + audit queries (never secrets).
      recipient_code:
        (created.rawPayload?.recipient_code as string | undefined) ??
        readStoredRecipientCode(withdrawal),
      reference_sent: withdrawal.ref,
    });

    await tx
      .update(withdrawalRequests)
      .set({
        providerReference: created.providerReference,
        providerStatus: created.status,
        providerMessage: clampText(created.message),
        providerPayload: payload,
        updatedAt: new Date(),
      })
      .where(eq(withdrawalRequests.id, withdrawal.id));

    await recordWithdrawalEvent(tx, {
      withdrawalId: withdrawal.id,
      withdrawalRef: withdrawal.ref,
      event: "moved_to_processing",
      previousStatus: "processing",
      newStatus: "processing",
      ...actorFields,
      providerReference: created.providerReference,
      reason: clampText(created.message, 240),
      metadata: { provider: provider.name, reference: withdrawal.ref },
    });

    return {
      attempted: true,
      outcome: "initiated",
      providerReference: created.providerReference,
      message: created.message || `Transfer ${created.providerReference} initiated`,
    };
  } catch (error) {
    // --- Path 4: ambiguous (timeout/network/duplicate-reference). ---------
    // NEVER mint a new reference: keep the SAME stable reference, mark the
    // provider state unknown, and let reconciliation resolve it.
    if (error instanceof PaystackTransferAmbiguousError) {
      const message = error.message;
      await tx
        .update(withdrawalRequests)
        .set({
          providerStatus: "unknown",
          providerMessage: clampText(message),
          providerPayload: mergePayload(withdrawal.providerPayload, {
            ambiguous: true,
            reference_sent: withdrawal.ref,
            ambiguous_at: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        })
        .where(eq(withdrawalRequests.id, withdrawal.id));
      await recordWithdrawalEvent(tx, {
        withdrawalId: withdrawal.id,
        withdrawalRef: withdrawal.ref,
        event: "provider_timeout",
        previousStatus: "processing",
        newStatus: "processing",
        ...actorFields,
        reason: clampText(message, 240),
        metadata: { reference: withdrawal.ref, ambiguous: true },
      });
      return { attempted: true, outcome: "ambiguous", providerReference: null, message };
    }

    // --- Path 5: definitive provider failure. ------------------------------
    // No transfer was created (validation / insufficient balance / bad
    // recipient). Retryable later under the SAME reference. No refund: the
    // funds stay debited while the payout is recoverable.
    const message = (error as Error)?.message ?? "Payout initiation failed";
    await tx
      .update(withdrawalRequests)
      .set({
        providerStatus: "initiation_failed",
        providerMessage: clampText(message),
        providerPayload: mergePayload(withdrawal.providerPayload, {
          reference_sent: withdrawal.ref,
          initiation_failed_at: new Date().toISOString(),
        }),
        updatedAt: new Date(),
      })
      .where(eq(withdrawalRequests.id, withdrawal.id));
    await recordWithdrawalEvent(tx, {
      withdrawalId: withdrawal.id,
      withdrawalRef: withdrawal.ref,
      event: "payout_failed",
      previousStatus: "processing",
      newStatus: "processing",
      ...actorFields,
      reason: clampText(message, 240),
      metadata: { reference: withdrawal.ref },
    });
    return { attempted: true, outcome: "failed", providerReference: null, message };
  }
}
