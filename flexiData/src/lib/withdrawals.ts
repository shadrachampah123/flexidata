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
 * Allowed `withdrawal_requests.status` transitions. Approval (`pending ->
 * processing`) authorizes a payout; it does NOT complete one. There is
 * deliberately NO edge to `successful` reachable from any current API: that
 * transition belongs to a future payout-provider completion webhook, and this
 * release must not (and cannot) express it.
 */
export const WITHDRAWAL_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["processing", "rejected"],
  processing: [],
  successful: [],
  failed: [],
  rejected: [],
  cancelled: [],
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
 * The admin approval API narrowed to what it may express: `approve` authorizes
 * (`processing`), `reject` refuses (`rejected`). No action, parameter or smuggled
 * field can name `successful` — completion is unreachable through this API.
 */
export const ADMIN_WITHDRAWAL_ACTIONS = {
  approve: "processing",
  reject: "rejected",
} as const;
export type AdminWithdrawalAction = keyof typeof ADMIN_WITHDRAWAL_ACTIONS;
