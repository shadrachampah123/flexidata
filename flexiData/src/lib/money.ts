/**
 * Exact cedi/pesewa money handling for every money path (deposits, withdrawals,
 * transfers, fee quotes).
 *
 * Why this module exists: JavaScript binary floating point cannot represent
 * most decimal cedi amounts exactly, and an earlier client implementation
 * stripped the decimal point from custom amounts (`"5.50"` -> `"550"`), turning
 * GH₵5.50 into GH₵550. Both failure modes are closed here by one rule:
 *
 *   every amount is parsed ONCE, strictly, into integer pesewas, and every
 *   calculation below (fees, nets, stored values) is integer arithmetic.
 *
 * The server NEVER trusts a client-provided parsed value: each route parses the
 * raw `amount` field itself with {@link parseCedisAmount}. The client uses the
 * SAME functions for its previews, so a displayed quote can never disagree
 * with what the server charges.
 *
 * This module is intentionally client-safe (no `server-only`, no Node APIs) so
 * the wallet UI and the API routes share it literally.
 */

/** Integer minor units per cedi. */
export const PESEWAS_PER_CEDI = 100;

/** Minimum withdrawal: GH₵5.00, in pesewas. */
export const WITHDRAW_MIN_PESEWAS = 500;

/** Withdrawal fee: 2% expressed as an exact integer ratio (never 0.02). */
export const WITHDRAW_FEE_NUMERATOR = 2;
export const WITHDRAW_FEE_DENOMINATOR = 100;

/**
 * `numeric(12,2)` holds at most ten digits before the decimal point; anything
 * larger cannot be stored exactly and is refused rather than rounded.
 */
export const MAX_CEDI_INTEGER_DIGITS = 10;

/** Longest exact input we accept (`9999999999.99` is 13 chars; 16 is headroom). */
const MAX_INPUT_LENGTH = 16;

export type CedisParseResult =
  | { ok: true; /** Canonical exact cedi string (`"5.50"`), safe for `numeric`. */ cedis: string; /** Integer pesewas. */ pesewas: number }
  | { ok: false; error: string };

/**
 * Reduce a raw money input to its canonical exact decimal string, or `null`.
 *
 * Accepts JSON numbers and strings only. Everything else (null, booleans,
 * arrays, objects) is refused: an amount must be an amount, never a coerced
 * guess. Numbers go through their shortest round-trip string form, so a float
 * that is not exactly a 2dp decimal (`0.30000000000000004`, `1e21`,
 * `Infinity`) fails the shape check below instead of being silently rounded.
 */
export function sanitizeCedisInput(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return sanitizeCedisInput(String(value));
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || s.length > MAX_INPUT_LENGTH) return null;
  // No sign, no exponent, no thousands separators, at most two decimals.
  // Leading zeros are harmless (`"007.50"` is unambiguously 750 pesewas).
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return null;
  return s;
}

/**
 * Parse a raw money input into integer pesewas plus its canonical cedi string.
 * Zero, negatives (no `-` passes the shape check) and anything inexact are
 * refused — the caller adds its own range check (minimums/maximums) on top.
 */
export function parseCedisAmount(value: unknown): CedisParseResult {
  const s = sanitizeCedisInput(value);
  if (s === null) return { ok: false, error: "Enter a valid amount" };
  const [whole, frac = ""] = s.split(".");
  const pesewas = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(pesewas) || pesewas <= 0) {
    return { ok: false, error: "Enter a valid amount" };
  }
  return { ok: true, cedis: pesewasToCedisString(pesewas), pesewas };
}

/**
 * Exact inverse of the parsing above: integer pesewas -> `"123.45"`.
 * Only ever called with validated integers; anything else maps to `"0.00"`
 * rather than throwing inside a render path.
 */
export function pesewasToCedisString(pesewas: number): string {
  if (!Number.isSafeInteger(pesewas)) return "0.00";
  const sign = pesewas < 0 ? "-" : "";
  const p = Math.abs(pesewas);
  return `${sign}${Math.floor(p / 100)}.${(p % 100).toString().padStart(2, "0")}`;
}

export type WithdrawalQuote = {
  amountPesewas: number;
  feePesewas: number;
  netPesewas: number;
};

/**
 * The ONE withdrawal fee rule: exactly 2% in integer pesewas (single round),
 * net derived by subtraction. Used by the client preview AND the server
 * charge, so the two can never disagree (e.g. GH₵10.25 quotes and charges the
 * same fee). Invariant: `fee + net === amount`, always.
 */
export function withdrawalQuote(amountPesewas: number): WithdrawalQuote | null {
  if (!Number.isSafeInteger(amountPesewas) || amountPesewas <= 0) return null;
  const feePesewas = Math.round((amountPesewas * WITHDRAW_FEE_NUMERATOR) / WITHDRAW_FEE_DENOMINATOR);
  return { amountPesewas, feePesewas, netPesewas: amountPesewas - feePesewas };
}

/**
 * Display formatting from integer pesewas WITHOUT floating point
 * (`(539/100).toLocaleString()` would reintroduce binary error into the UI).
 */
export function moneyFromPesewas(pesewas: number): string {
  if (!Number.isSafeInteger(pesewas)) return "GH₵ 0.00";
  const sign = pesewas < 0 ? "−" : "";
  const p = Math.abs(pesewas);
  const whole = Math.floor(p / 100).toLocaleString("en-GH");
  return `${sign}GH₵ ${whole}.${(p % 100).toString().padStart(2, "0")}`;
}
