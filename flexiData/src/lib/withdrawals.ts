/**
 * Withdrawal request validation + lifecycle transitions (server-authoritative).
 *
 * `validateWithdrawalRequestBody` is the single gate in front of
 * `POST /api/wallet/withdraw`: strict object shape, whitelisted method,
 * strictly-normalized destination matched to that method's network, exactly
 * parsed amount, and a well-formed idempotency key. It runs BEFORE any wallet
 * deduction or other financial mutation, and anything it rejects leaves zero
 * ledger/wallet side effects.
 *
 * `WITHDRAWAL_TRANSITIONS` separates approval from payout completion: an admin
 * approval moves `pending -> processing` (authorized, awaiting a payout
 * provider); NOTHING in this release moves a row to `successful` — that edge is
 * reserved for a future provider completion webhook that does not exist yet.
 */

import {
  parseCedisAmount,
  withdrawalQuote,
  WITHDRAW_MIN_PESEWAS,
  type WithdrawalQuote,
} from "@/lib/money";
import {
  normalizeGhanaMobileStrict,
  withdrawalMethodMatchesNetwork,
  WITHDRAWAL_METHOD_META,
  WITHDRAWAL_METHODS,
  type GhanaNetwork,
  type WithdrawalMethod,
} from "@/lib/ghana-mobile";

/** The ONLY keys `POST /api/wallet/withdraw` accepts. Anything else is smuggling. */
export const WITHDRAWAL_REQUEST_KEYS = ["amount", "method", "dest", "idempotencyKey"] as const;

/** Matches `varchar(40)` on `withdrawal_requests.destination_method`. */
export const MAX_METHOD_LENGTH = 40;
/** Raw destination input cap (a valid spelling is at most ~16 chars). */
export const MAX_DEST_LENGTH = 32;
/**
 * Client idempotency keys: UUIDs, hex/nano tokens (`A-Za-z0-9_-`, 8–64 chars).
 * Matches `varchar(64)` on `withdrawal_requests.idempotency_key`.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export type ValidatedWithdrawalRequest = {
  amountPesewas: number;
  amountCedis: string;
  feeCedis: string;
  netCedis: string;
  quote: WithdrawalQuote;
  method: WithdrawalMethod;
  msisdn10: string;
  network: GhanaNetwork;
  /**
   * The client's key, or `null` when the client sent none — the route mints a
   * fresh UUID in that case (legacy clients stay working; only keyed requests
   * are idempotent across retries).
   */
  idempotencyKey: string | null;
};

export type WithdrawalRequestValidation =
  | { ok: true; value: ValidatedWithdrawalRequest }
  | { ok: false; error: string };

const fail = (error: string): WithdrawalRequestValidation => ({ ok: false, error });

/**
 * Strictly validate a withdrawal request body. Pure (no I/O) so it is cheap to
 * run first and easy to test exhaustively. On failure the route answers 400
 * and MUST NOT have touched the wallet, the withdrawal table or the ledger.
 */
export function validateWithdrawalRequestBody(body: unknown): WithdrawalRequestValidation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return fail("Invalid request");
  }
  const obj = body as Record<string, unknown>;
  const allowed = new Set<string>(WITHDRAWAL_REQUEST_KEYS);
  for (const key of Object.keys(obj)) {
    // `walletId`, `userId`, `status`, `balance`, … — the authenticated server
    // identity determines user/wallet/authorization, never the client. A body
    // carrying any of these is a smuggling attempt and is refused outright
    // (not silently ignored), so a malicious client gets no oracle.
    if (!allowed.has(key)) return fail("Invalid request");
  }

  if (!("amount" in obj)) return fail("Enter an amount");
  const parsed = parseCedisAmount(obj.amount);
  if (!parsed.ok) return fail(parsed.error);
  if (parsed.pesewas < WITHDRAW_MIN_PESEWAS) return fail("Minimum withdrawal is GH₵5");

  const method = obj.method;
  if (typeof method !== "string" || method.length === 0 || method.length > MAX_METHOD_LENGTH) {
    return fail("Choose a withdrawal method");
  }
  if (!(WITHDRAWAL_METHODS as readonly string[]).includes(method)) {
    return fail("Unsupported withdrawal method");
  }
  const whitelisted = method as WithdrawalMethod;

  if (!("dest" in obj)) return fail("Enter a destination mobile money number");
  const dest = obj.dest;
  if (typeof dest === "string" && dest.length > MAX_DEST_LENGTH) {
    return fail("Enter a destination mobile money number");
  }
  const normalized = normalizeGhanaMobileStrict(dest);
  if (!normalized.ok) return fail(normalized.error);
  if (!withdrawalMethodMatchesNetwork(whitelisted, normalized.network)) {
    const expected = WITHDRAWAL_METHOD_META[whitelisted];
    const article = expected.network === "MTN" ? "an" : "a";
    return fail(`${expected.label} withdrawals must go to ${article} ${expected.network} number`);
  }

  let idempotencyKey: string | null = null;
  if ("idempotencyKey" in obj) {
    const key = obj.idempotencyKey;
    // Present-but-malformed (null, wrong type, bad shape) is a 400: an
    // idempotency key the database cannot enforce is worse than none.
    if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      return fail("Invalid idempotency key");
    }
    idempotencyKey = key;
  }

  const quote = withdrawalQuote(parsed.pesewas);
  if (!quote) return fail("Enter an amount");

  return {
    ok: true,
    value: {
      amountPesewas: parsed.pesewas,
      amountCedis: parsed.cedis,
      feeCedis: centsToCedis(quote.feePesewas),
      netCedis: centsToCedis(quote.netPesewas),
      quote,
      method: whitelisted,
      msisdn10: normalized.msisdn10,
      network: normalized.network,
      idempotencyKey,
    },
  };
}

function centsToCedis(pesewas: number): string {
  return `${Math.floor(pesewas / 100)}.${(pesewas % 100).toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/**
 * Allowed `withdrawal_requests.status` transitions.
 *
 * Lifecycle:
 *   pending → processing → successful (via provider callback)
 *   pending → rejected
 *   processing → rejected (admin rejection after approval)
 *   processing → refunded (provider failure or reversal)
 *   processing → successful (verified provider confirmation)
 *
 * The `successful` transition is ONLY reachable via the provider callback
 * endpoint (Phase 6) — NOT via any admin API. Admin approval moves to
 * `processing` only; completion requires verified provider confirmation.
 */
export const WITHDRAWAL_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["processing", "rejected"],
  processing: ["successful", "rejected", "refunded"],
  successful: [],
  failed: [],
  rejected: [],
  cancelled: [],
  refunded: [],
};

export class WithdrawalTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Withdrawal cannot move from ${from} to ${to}`);
    this.name = "WithdrawalTransitionError";
  }
}

/** True when `from -> to` is an allowed lifecycle edge. */
export function canTransitionWithdrawal(from: string, to: string): boolean {
  return WITHDRAWAL_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throw {@link WithdrawalTransitionError} unless `from -> to` is allowed. */
export function assertWithdrawalTransition(from: string, to: string): void {
  if (!canTransitionWithdrawal(from, to)) {
    throw new WithdrawalTransitionError(from, to);
  }
}

/**
 * The admin withdrawal API narrowed to what it may express: `approve`
 * authorizes (`processing`), `reject` refuses (`rejected`), `refund` returns
 * funds (`refunded`), and `retry` re-attempts payout initiation for a
 * `processing` withdrawal (staying in `processing` — it reuses the SAME stable
 * provider reference and can never fork a second transfer). No action,
 * parameter or smuggled field can name `successful` — completion is
 * unreachable through this API and belongs to a verified provider callback.
 */
export const ADMIN_WITHDRAWAL_ACTIONS = {
  approve: "processing",
  reject: "rejected",
  refund: "refunded",
  retry: "processing",
} as const;
export type AdminWithdrawalAction = keyof typeof ADMIN_WITHDRAWAL_ACTIONS;

/**
 * Provider states in which a payout must be treated as ALREADY IN FLIGHT (or
 * ambiguous) — money may be moving at the provider right now.
 *
 * `unknown` is the ambiguous outcome recorded by `executeWithdrawalPayout`
 * when initiation timed out / failed at the network level / was refused as a
 * duplicate reference. In that state we do NOT know whether Paystack accepted
 * the transfer, so it must be treated exactly like a live one.
 */
export const IN_FLIGHT_PROVIDER_STATUSES = ["unknown"] as const;

/**
 * The production-safety gate in front of the money-returning admin actions
 * (`reject` and `refund`).
 *
 * THE VULNERABILITY THIS CLOSES: both actions unconditionally credited
 * `wallets.balance` back and marked the withdrawal ledger row `failed`. When a
 * provider transfer was already initiated (a `provider_reference` exists) or
 * its fate was unknowable (`provider_status = 'unknown'`), the user could be
 * paid TWICE — once by Paystack settling the in-flight transfer, and once by
 * the wallet restoration. That is an unrecoverable double-spend.
 *
 * The rule is deliberately conservative and purely local (no provider call, so
 * it cannot fail open on a network error): if there is ANY evidence a transfer
 * exists or might exist, the refund path is closed. Resolution belongs to the
 * provider callback (`transfer.success` settles it, `transfer.failed` /
 * `transfer.reversed` refunds it) or to payout reconciliation — never to an
 * admin guessing.
 */
export function payoutIsInFlight(withdrawal: {
  providerReference?: string | null;
  providerStatus?: string | null;
}): boolean {
  const ref = withdrawal.providerReference?.trim();
  if (ref) return true;
  const status = withdrawal.providerStatus?.trim().toLowerCase();
  if (!status) return false;
  return (IN_FLIGHT_PROVIDER_STATUSES as readonly string[]).includes(status);
}

/** Machine-readable code returned with the 409 from the in-flight gate. */
export const PAYOUT_IN_FLIGHT_CODE = "payout_in_flight";

/** Operator-facing explanation for a refused reject/refund. */
export function payoutInFlightMessage(withdrawal: {
  providerReference?: string | null;
  providerStatus?: string | null;
}): string {
  const ref = withdrawal.providerReference?.trim();
  const status = withdrawal.providerStatus?.trim().toLowerCase();
  const why = ref
    ? `a payout transfer (${ref}) has already been sent to the provider`
    : "the payout provider's response was ambiguous, so a transfer may already exist";
  return (
    `This withdrawal cannot be rejected or refunded: ${why}` +
    (status ? ` (provider status: ${status})` : "") +
    ". NOTHING was changed and NO wallet refund was applied — refunding now could pay the " +
    "customer twice if the provider settles the transfer. Wait for the provider callback " +
    "(transfer.success settles it; transfer.failed or transfer.reversed refunds it " +
    "automatically), or resolve it through payout reconciliation."
  );
}

/** Valid events for the withdrawal audit trail (Phase 4). */
export const WITHDRAWAL_AUDIT_EVENTS = [
  "created",
  "approved",
  "rejected",
  "moved_to_processing",
  "callback_received",
  "marked_successful",
  "payout_failed",
  "refunded",
  "provider_timeout",
] as const;
export type WithdrawalAuditEvent = (typeof WITHDRAWAL_AUDIT_EVENTS)[number];

/** Valid exception types for payout reconciliation (Phase 7). */
export const RECONCILIATION_EXCEPTION_TYPES = [
  "stuck_processing",
  "provider_success_local_processing",
  "provider_failure_local_processing",
  "amount_mismatch",
  "duplicate_provider_reference",
  "unknown_provider_reference",
  "currency_mismatch",
] as const;
export type ReconciliationExceptionType = (typeof RECONCILIATION_EXCEPTION_TYPES)[number];
