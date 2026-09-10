import "server-only";

/**
 * Temporary production kill switch for the ENTIRE withdrawal/payout feature.
 *
 * While Paystack Transfers / third-party payouts are not approved for the
 * FlexiData Paystack account (Starter Business), withdrawals must be
 * completely inactive. This module is the single definition of that switch;
 * every withdrawal/payout entry point consults it server-side:
 *
 *   - `POST /api/wallet/withdraw` (creation — before any debit/row/ledger)
 *   - `POST /api/admin/withdrawals/[id]/action` (`approve` + `retry` only —
 *     `reject`/`refund` reconciliation for historical records keeps working)
 *   - `executeWithdrawalPayout` (the payout choke point — before any provider
 *     resolution or network I/O)
 *   - `PayoutProvider.createPayout` (both the Paystack and mock adapters)
 *   - `createMomoRecipient` / `createBankRecipient` / `initiateTransfer`
 *     (the lowest Paystack transfer layer — before any network I/O)
 *
 * FAIL-CLOSED: withdrawals are enabled ONLY when `WITHDRAWALS_ENABLED` is
 * explicitly `true` (trimmed, case-insensitive). Missing, empty, `false`,
 * `0`, `1`, `yes`, `on` — anything else — means DISABLED. This deliberately
 * narrows the repo's usual `envBool` convention (`1`/`yes`/`on` do NOT count):
 * the feature must never accidentally become enabled.
 *
 * Deliberately NOT gated (historical records must keep working):
 *   - reading withdrawal history (user + admin lists/detail)
 *   - `reject` / `refund` admin actions on historical records
 *   - the provider callback (`transfer.success` / `transfer.failed` /
 *     `transfer.reversed` settlement for in-flight payouts)
 *   - payout reconciliation + status reads (`getPayoutStatus`/`fetchTransfer`)
 *   - deposits, transfers, data purchases, and all other wallet functionality
 *
 * FUTURE REACTIVATION: after FlexiData is registered and Paystack
 * Transfers/third-party payouts are approved, set `WITHDRAWALS_ENABLED=true`
 * — no code changes, no payout rewrite. Do NOT remove the payout
 * implementation while this switch exists.
 */
export const WITHDRAWALS_ENV_VAR = "WITHDRAWALS_ENABLED";

/** Machine-readable code returned with every withdrawals-disabled refusal. */
export const WITHDRAWALS_DISABLED_CODE = "withdrawals_disabled";

/**
 * The user-facing line. Shown verbatim in the withdrawal UI (user + admin)
 * whenever the feature is disabled.
 */
export const WITHDRAWALS_DISABLED_MESSAGE = "Withdrawals are temporarily unavailable.";

/**
 * API-facing refusal text: the same line plus what still works, so an API
 * consumer (or a retry path) gets an actionable answer.
 */
export const WITHDRAWALS_DISABLED_ERROR =
  "Withdrawals are temporarily unavailable. New withdrawal requests, approvals and payout " +
  "retries are paused while we complete payment-provider approval. Deposits, transfers and " +
  "data purchases still work, and your existing withdrawal history is unchanged.";

/**
 * True ONLY when `WITHDRAWALS_ENABLED` is explicitly `true` (trimmed,
 * case-insensitive). Missing or any other value → false (disabled).
 */
export function isWithdrawalsEnabled(): boolean {
  return (process.env[WITHDRAWALS_ENV_VAR] ?? "").trim().toLowerCase() === "true";
}

/** Thrown by {@link assertWithdrawalsEnabled} when withdrawals are disabled. */
export class WithdrawalsDisabledError extends Error {
  readonly code = WITHDRAWALS_DISABLED_CODE;
  constructor() {
    super(WITHDRAWALS_DISABLED_ERROR);
    this.name = "WithdrawalsDisabledError";
  }
}

/**
 * Throw {@link WithdrawalsDisabledError} unless withdrawals are explicitly
 * enabled. Call this FIRST in every payout-execution path — before any
 * provider resolution, validation side effect, or network I/O.
 */
export function assertWithdrawalsEnabled(): void {
  if (!isWithdrawalsEnabled()) {
    throw new WithdrawalsDisabledError();
  }
}
