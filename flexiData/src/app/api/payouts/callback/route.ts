import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  wallets,
  withdrawalRequests,
  transactions,
  payoutReconciliationExceptions,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import {
  assertWithdrawalTransition,
  WithdrawalTransitionError,
} from "@/lib/withdrawals";
import { recordWithdrawalEvent } from "@/lib/withdrawal-audit";
import {
  getPayoutProvider,
} from "@/lib/payout-service";
import { ensureWithdrawalSchema } from "@/lib/seed";
import { ensurePayoutSystemSchema } from "@/lib/seed";
import { cedisToPesewas } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * POST /api/payouts/callback
 *
 * Secure webhook endpoint for payout provider callbacks (Phase 6 + Phase B).
 *
 * Handles provider lifecycle events — Paystack `transfer.success` /
 * `transfer.failed` / `transfer.reversed` (or the mock provider's equivalents
 * in development): successful payout, failed payout, reversed payout, or a
 * pending/processing update.
 *
 * Security requirements met:
 *   - Provider signature verification (via provider adapter) is MANDATORY —
 *     unsigned/invalid callbacks are rejected with 401 before any state read
 *   - Signed-but-unsupported events are acked with 200 and IGNORED (no state
 *     change, no exception) so provider retries cannot wedge the endpoint
 *   - Callbacks are idempotent (duplicate deliveries cannot double-refund or
 *     double-credit: conditional ledger updates + terminal-state guards)
 *   - Does NOT trust amount/user/wallet from callback — looks up by reference
 *   - Verifies expected amount (exact integer pesewas — never floats) and
 *     currency; mismatches become reconciliation exceptions, never settlements
 *   - Unknown provider references become reconciliation exceptions (never
 *     fabricate a withdrawal)
 *   - Verifies withdrawal is in valid state before transition
 *   - Locks withdrawal + wallet rows where required
 *   - Failed/reversed payouts restore the wallet EXACTLY once (conditional
 *     `status = 'pending'` ledger claim); successful payouts are terminal
 *   - Never creates money from nothing
 */
export async function POST(req: Request) {
  const ref = randomBytes(3).toString("hex").toUpperCase();

  try {
    // 1. Read the raw body BEFORE JSON parsing (needed for signature verification)
    const rawBody = await req.text();
    if (!rawBody || rawBody.trim() === "") {
      return NextResponse.json(
        { ok: false, error: "Empty callback body" },
        { status: 400, headers: NO_STORE },
      );
    }

    // 2. Collect relevant headers for signature verification
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of req.headers.entries()) {
      if (
        key.startsWith("x-") ||
        key === "signature" ||
        key === "authorization" ||
        key === "content-type"
      ) {
        headers[key] = value;
      }
    }

    // 3. Verify the callback signature via the provider adapter
    let provider: ReturnType<typeof getPayoutProvider>;
    try {
      provider = getPayoutProvider();
    } catch {
      console.error(
        `[flexidata] payout callback rejected: no provider configured ref=${ref}`,
      );
      return NextResponse.json(
        { ok: false, error: "Payout provider not configured" },
        { status: 503, headers: NO_STORE },
      );
    }

    const verification = await provider.verifyCallback(rawBody, headers);
    if (!verification.ok) {
      console.warn(
        `[flexidata] payout callback rejected: invalid signature ref=${ref} error=${verification.error}`,
      );
      return NextResponse.json(
        { ok: false, error: "Invalid callback signature" },
        { status: 401, headers: NO_STORE },
      );
    }

    const callbackData = verification.data;

    // 4. Signed-but-unsupported events (e.g. a non-transfer Paystack event):
    // ack with 200 and perform NO database effect — no lookup, no exception,
    // no state change. Returning an error here would make the provider retry
    // a callback that can never succeed.
    if (callbackData.ignored) {
      return NextResponse.json(
        { ok: true, ignored: true },
        { status: 200, headers: NO_STORE },
      );
    }

    // 5. Schema self-heal
    await ensureWithdrawalSchema();
    await ensurePayoutSystemSchema();

    // 6. Look up the withdrawal by provider reference
    const result = await db.transaction(async (tx) => {
      // Find the withdrawal by provider reference
      let [withdrawal] = await tx
        .select()
        .from(withdrawalRequests)
        .where(eq(withdrawalRequests.providerReference, callbackData.providerReference))
        .for("update");

      if (!withdrawal && callbackData.withdrawalRef) {
        // Fallback: the provider echoed OUR stable reference (the withdrawal
        // ref) but we have not stored its transfer code yet — the webhook won
        // a race with the submit transaction. Look up by our own ref (which
        // the signature authenticates) and adopt the transfer code.
        const [byRef] = await tx
          .select()
          .from(withdrawalRequests)
          .where(eq(withdrawalRequests.ref, callbackData.withdrawalRef))
          .for("update");
        if (byRef) {
          if (byRef.providerReference && byRef.providerReference !== callbackData.providerReference) {
            // This withdrawal already belongs to a DIFFERENT provider
            // transfer — adopting this one would fork it. Exception, no state
            // change.
            await tx.insert(payoutReconciliationExceptions).values({
              withdrawalId: byRef.id,
              withdrawalRef: byRef.ref,
              exceptionType: "duplicate_provider_reference",
              description:
                `Callback for ${callbackData.providerReference} names withdrawal ${byRef.ref}, ` +
                `which is already bound to ${byRef.providerReference}`,
              localStatus: byRef.status,
              providerStatus: callbackData.status,
              providerReference: callbackData.providerReference,
              currency: byRef.currency || "GHS",
            });
            return { error: "Conflicting provider reference", status: 409 };
          }
          if (!byRef.providerReference) {
            // Nobody else may own this transfer code (pre-check so the
            // adoption below cannot hit the 0010 unique index under normal
            // operation; a microscopic race would still fail LOUDLY via the
            // index rather than forking silently).
            const [owner] = await tx
              .select({ id: withdrawalRequests.id, ref: withdrawalRequests.ref })
              .from(withdrawalRequests)
              .where(eq(withdrawalRequests.providerReference, callbackData.providerReference))
              .limit(1);
            if (owner) {
              await tx.insert(payoutReconciliationExceptions).values({
                withdrawalId: byRef.id,
                withdrawalRef: byRef.ref,
                exceptionType: "duplicate_provider_reference",
                description:
                  `Callback for ${callbackData.providerReference} names withdrawal ${byRef.ref}, ` +
                  `but that transfer is already bound to ${owner.ref}`,
                localStatus: byRef.status,
                providerStatus: callbackData.status,
                providerReference: callbackData.providerReference,
                currency: byRef.currency || "GHS",
              });
              return { error: "Conflicting provider reference", status: 409 };
            }
            await tx
              .update(withdrawalRequests)
              .set({
                providerReference: callbackData.providerReference,
                providerPayload: mergeProviderPayload(byRef.providerPayload, {
                  ...(callbackData.rawPayload ?? {}),
                  adopted_via_callback_at: new Date().toISOString(),
                }),
                updatedAt: new Date(),
              })
              .where(eq(withdrawalRequests.id, byRef.id));
            withdrawal = { ...byRef, providerReference: callbackData.providerReference };
          } else {
            withdrawal = byRef;
          }
        }
      }

      if (!withdrawal) {
        // Unknown provider reference — create a reconciliation exception
        await tx.insert(payoutReconciliationExceptions).values({
          exceptionType: "unknown_provider_reference",
          description: `Callback received for unknown provider reference: ${callbackData.providerReference}`,
          providerReference: callbackData.providerReference,
          providerStatus: callbackData.status,
          expectedAmount: callbackData.amount ?? null,
          currency: callbackData.currency || "GHS",
        });
        return { error: "Unknown provider reference", status: 404 };
      }

      // 7. Verify currency matches (case-insensitive; stored verbatim)
      if (
        callbackData.currency &&
        callbackData.currency.toUpperCase() !== (withdrawal.currency || "GHS").toUpperCase()
      ) {
        await tx.insert(payoutReconciliationExceptions).values({
          withdrawalId: withdrawal.id,
          withdrawalRef: withdrawal.ref,
          exceptionType: "currency_mismatch",
          description: `Callback currency ${callbackData.currency} does not match expected ${withdrawal.currency}`,
          localStatus: withdrawal.status,
          providerStatus: callbackData.status,
          providerReference: callbackData.providerReference,
          expectedAmount: String(withdrawal.netAmount),
          actualAmount: callbackData.amount ?? null,
          currency: callbackData.currency,
        });
        return { error: "Currency mismatch", status: 400 };
      }

      // 8. Verify amount matches EXACTLY in integer pesewas (never floats — a
      // binary-float comparison could settle GH₵4.90 against GH₵4.89). Either
      // side unparseable is itself a mismatch: never settle on amounts we
      // cannot prove equal.
      if (callbackData.amount) {
        const callbackPesewas = cedisToPesewas(callbackData.amount);
        const expectedPesewas = cedisToPesewas(String(withdrawal.netAmount));
        if (callbackPesewas === null || expectedPesewas === null || callbackPesewas !== expectedPesewas) {
          await tx.insert(payoutReconciliationExceptions).values({
            withdrawalId: withdrawal.id,
            withdrawalRef: withdrawal.ref,
            exceptionType: "amount_mismatch",
            description: `Callback amount ${callbackData.amount} does not match expected net amount ${withdrawal.netAmount}`,
            localStatus: withdrawal.status,
            providerStatus: callbackData.status,
            providerReference: callbackData.providerReference,
            expectedAmount: String(withdrawal.netAmount),
            actualAmount: callbackData.amount,
            currency: withdrawal.currency,
          });
          return { error: "Amount mismatch", status: 400 };
        }
      }

      // 9. Determine the target status from the callback outcome
      let targetStatus: string;
      let auditEvent: "callback_received" | "marked_successful" | "payout_failed" | "refunded";
      switch (callbackData.status) {
        case "successful":
          targetStatus = "successful";
          auditEvent = "marked_successful";
          break;
        case "failed":
          targetStatus = "refunded";
          auditEvent = "refunded";
          break;
        case "reversed":
          targetStatus = "refunded";
          auditEvent = "refunded";
          break;
        case "pending":
          // Provider says still pending — no state change needed
          await recordWithdrawalEvent(tx, {
            withdrawalId: withdrawal.id,
            withdrawalRef: withdrawal.ref,
            event: "callback_received",
            previousStatus: withdrawal.status,
            newStatus: withdrawal.status,
            actorType: "provider",
            providerReference: callbackData.providerReference,
            reason: callbackData.message || null,
            metadata: { source: "callback", status_reported: callbackData.status },
          });
          await tx
            .update(withdrawalRequests)
            .set({
              providerStatus: callbackData.status,
              providerMessage: callbackData.message || null,
              // MERGE, never replace: the stored payload holds the recipient
              // code + stable reference the payout path persisted.
              providerPayload: mergeProviderPayload(withdrawal.providerPayload, {
                ...(callbackData.rawPayload ?? {}),
                last_callback_at: new Date().toISOString(),
              }),
              updatedAt: new Date(),
            })
            .where(eq(withdrawalRequests.id, withdrawal.id));
          return { ok: true, status: "no_change", ref: withdrawal.ref };
        default:
          return { error: "Unknown callback status", status: 400 };
      }

      // 10. Validate the state transition
      try {
        assertWithdrawalTransition(withdrawal.status, targetStatus);
      } catch (error) {
        if (error instanceof WithdrawalTransitionError) {
          if (withdrawal.status === targetStatus) {
            // Idempotent: already in target state
            await recordWithdrawalEvent(tx, {
              withdrawalId: withdrawal.id,
              withdrawalRef: withdrawal.ref,
              event: "callback_received",
              previousStatus: withdrawal.status,
              newStatus: withdrawal.status,
              actorType: "provider",
              providerReference: callbackData.providerReference,
              reason: "Duplicate callback (already in target state)",
              metadata: { idempotent: true, source: "callback" },
            });
            return { ok: true, status: "idempotent", ref: withdrawal.ref };
          }
          return {
            error: `Invalid state transition: ${withdrawal.status} → ${targetStatus}`,
            status: 409,
          };
        }
        throw error;
      }

      // 11. Record the callback event
      await recordWithdrawalEvent(tx, {
        withdrawalId: withdrawal.id,
        withdrawalRef: withdrawal.ref,
        event: auditEvent,
        previousStatus: withdrawal.status,
        newStatus: targetStatus,
        actorType: "provider",
        providerReference: callbackData.providerReference,
        reason: callbackData.message || null,
        metadata: { source: "callback", status_reported: callbackData.status },
      });

      // 12. Apply the state change
      const now = new Date();
      await tx
        .update(withdrawalRequests)
        .set({
          status: targetStatus as "successful" | "refunded",
          providerStatus: callbackData.status,
          providerMessage: callbackData.message || null,
          // MERGE, never replace: the stored payload holds the recipient
          // code + stable reference the payout path persisted.
          providerPayload: mergeProviderPayload(withdrawal.providerPayload, {
            ...(callbackData.rawPayload ?? {}),
            last_callback_at: now.toISOString(),
          }),
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(withdrawalRequests.id, withdrawal.id));

      // 13. Update the ledger row to match
      if (targetStatus === "successful") {
        await tx.execute(
          sql`UPDATE transactions
              SET status = 'successful',
                  provider_status = 'successful',
                  provider_message = ${callbackData.message || "Payout confirmed by provider"},
                  fulfilled_at = ${now}
              WHERE ref = ${withdrawal.ref}
                AND wallet_id = ${withdrawal.walletId}
                AND type = 'withdrawal'`,
        );
      } else if (targetStatus === "refunded") {
        // Refund the wallet
        const [lockedWallet] = await tx
          .select({ id: wallets.id, userId: wallets.userId, balance: wallets.balance })
          .from(wallets)
          .where(eq(wallets.id, withdrawal.walletId))
          .for("update");

        if (!lockedWallet) {
          throw new Error(`Wallet ${withdrawal.walletId} not found for refund`);
        }

        if (lockedWallet.userId !== withdrawal.userId) {
          throw new Error(
            `Withdrawal ${withdrawal.ref}: wallet ${withdrawal.walletId} user mismatch`,
          );
        }

        // Verify ledger row is in expected state
        const [ledger] = await tx
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.ref, withdrawal.ref),
              eq(transactions.walletId, withdrawal.walletId),
            ),
          )
          .for("update");

        if (!ledger || ledger.type !== "withdrawal") {
          throw new Error(
            `No withdrawal ledger row for ${withdrawal.ref} — cannot refund`,
          );
        }

        if (ledger.status === "failed" || ledger.status === "reversed") {
          // Already refunded — idempotent
          return { ok: true, status: "idempotent", ref: withdrawal.ref };
        }

        if (ledger.status !== "pending") {
          throw new Error(
            `Ledger for ${withdrawal.ref} is ${ledger.status} — unexpected state for refund`,
          );
        }

        // Credit back the gross amount
        await tx
          .update(wallets)
          .set({ balance: sql`${wallets.balance} + ${withdrawal.amount}` })
          .where(eq(wallets.id, withdrawal.walletId));

        // Mark the ledger row as failed (refunded)
        const ledgerRes = await tx.execute(
          sql`UPDATE transactions
              SET status = 'failed',
                  provider_message = ${callbackData.message || "Payout failed; refunded to wallet"},
                  refunded_at = ${now}
              WHERE ref = ${withdrawal.ref}
                AND wallet_id = ${withdrawal.walletId}
                AND status = 'pending'`,
        );
        if ((ledgerRes as { rowCount?: number }).rowCount === 0) {
          throw new Error(`Ledger update for ${withdrawal.ref} matched no rows — rolling back`);
        }
      }

      return { ok: true, status: targetStatus, ref: withdrawal.ref };
    });

    if ("error" in result) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: result.status as number, headers: NO_STORE },
      );
    }

    return NextResponse.json(
      { ok: true, status: result.status, ref: result.ref },
      { status: 200, headers: NO_STORE },
    );
  } catch (err: unknown) {
    const message = (err as { message?: string })?.message ?? "Unknown error";
    console.error(
      `[flexidata] payout callback error ref=${ref}: ${message}`,
      err,
    );
    return NextResponse.json(
      { ok: false, error: `Callback processing failed (ref ${ref})` },
      { status: 500, headers: NO_STORE },
    );
  }
}

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/**
 * Merge callback payload fields into the stored provider payload WITHOUT
 * losing what the payout path persisted (recipient_code, reference_sent).
 * Neither side ever carries secrets — only provider identifiers + statuses.
 */
function mergeProviderPayload(
  existing: unknown,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, ...extra };
}
