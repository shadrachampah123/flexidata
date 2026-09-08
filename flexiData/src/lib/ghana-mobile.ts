/**
 * Strict Ghana mobile-number validation + the withdrawal method whitelist.
 *
 * Two rules this module enforces everywhere it is used:
 *
 *   1. NEVER silently truncate or guess a payout destination. A number that is
 *      not exactly a valid Ghana mobile number is REJECTED — the server never
 *      slices it down to something that happens to validate.
 *   2. Network/destination matching is explicit. A withdrawal method only pays
 *      to its own network's prefixes; a mismatch is a rejection, not a guess.
 *
 * Client-safe on purpose: the wallet UI previews with these helpers, but the
 * API routes re-validate from scratch — the browser is never authoritative.
 */

/** The ONLY withdrawal methods the server accepts. */
export const WITHDRAWAL_METHODS = ["momo_mtn", "telecel_cash"] as const;
export type WithdrawalMethod = (typeof WITHDRAWAL_METHODS)[number];

/** Trusted server-side metadata per method (labels, network). Never client input. */
export const WITHDRAWAL_METHOD_META: Record<WithdrawalMethod, { label: string; network: "MTN" | "TELECEL" }> = {
  momo_mtn: { label: "MTN MoMo", network: "MTN" },
  telecel_cash: { label: "Telecel Cash", network: "TELECEL" },
};

/** Ghana mobile prefixes by network (3-digit, 0XX form). */
export const MTN_PREFIXES = ["024", "025", "053", "054", "055", "059"] as const;
export const TELECEL_PREFIXES = ["020", "050"] as const;
/**
 * Recognized but NOT payout-capable: no withdrawal method pays to AirtelTigo,
 * so withdrawal validation rejects these while transfer validation (any
 * registered wallet) still accepts them.
 */
export const AIRTELTIGO_PREFIXES = ["026", "027", "056", "057"] as const;

export type GhanaNetwork = "MTN" | "TELECEL" | "AIRTELTIGO";

const PREFIX_NETWORK = new Map<string, GhanaNetwork>([
  ...MTN_PREFIXES.map((p): [string, GhanaNetwork] => [p, "MTN"]),
  ...TELECEL_PREFIXES.map((p): [string, GhanaNetwork] => [p, "TELECEL"]),
  ...AIRTELTIGO_PREFIXES.map((p): [string, GhanaNetwork] => [p, "AIRTELTIGO"]),
]);

export type GhanaMobileResult =
  | { ok: true; /** Canonical 10-digit `0XXXXXXXXX` form. */ msisdn10: string; network: GhanaNetwork }
  | { ok: false; error: string };

const INVALID_NUMBER = "Enter a valid Ghana mobile number";

/**
 * Strictly normalize any Ghana mobile input to `0XXXXXXXXX`.
 *
 * Accepted spellings (after trimming cosmetic separators): `0XXXXXXXXXX`
 * (10-digit), 9-digit local without the trunk `0`, `233XXXXXXXXX`,
 * `+233XXXXXXXXX` and `00233XXXXXXXXX`. Anything else — wrong length, bad
 * characters, unknown prefix — is rejected. In particular over-long inputs
 * (`02441234567`, 11+ digit garbage) are NEVER truncated into a valid number.
 *
 * @param networks when given, only these networks are accepted (withdrawals
 * pass the single network their method pays to; transfers accept all).
 */
export function normalizeGhanaMobileStrict(
  value: unknown,
  opts?: { networks?: readonly GhanaNetwork[] },
): GhanaMobileResult {
  if (typeof value !== "string") return { ok: false, error: INVALID_NUMBER };
  const raw = value.trim();
  if (raw === "" || raw.length > 24) return { ok: false, error: INVALID_NUMBER };
  // Cosmetic separators only; anything else (letters, extra symbols) fails closed.
  const stripped = raw.replace(/[\s\-.()]/g, "");
  if (!/^\+?\d+$/.test(stripped)) return { ok: false, error: INVALID_NUMBER };
  const digits = stripped.startsWith("+") ? stripped.slice(1) : stripped;

  let local: string | null = null;
  if (/^233\d{9}$/.test(digits)) local = `0${digits.slice(3)}`;
  else if (/^00233\d{9}$/.test(digits)) local = `0${digits.slice(5)}`;
  else if (/^0\d{9}$/.test(digits)) local = digits;
  else if (/^[1-9]\d{8}$/.test(digits)) local = `0${digits}`;
  // Every other shape (too short, too long, 10 digits without a trunk 0,
  // double country codes, …) is rejected — never truncated, never guessed.
  if (local === null) return { ok: false, error: INVALID_NUMBER };

  const network = PREFIX_NETWORK.get(local.slice(0, 3)) ?? null;
  if (network === null) return { ok: false, error: "That number is not on a supported Ghana network" };
  if (opts?.networks && !opts.networks.includes(network)) {
    return { ok: false, error: "That number is not on a supported Ghana network" };
  }
  return { ok: true, msisdn10: local, network };
}

/** True when `method` pays to `network` (the server-side match rule). */
export function withdrawalMethodMatchesNetwork(method: WithdrawalMethod, network: GhanaNetwork): boolean {
  return WITHDRAWAL_METHOD_META[method].network === network;
}

/**
 * The ledger subtitle for a withdrawal, built ONLY from whitelist metadata and
 * the already-normalized destination digits. No client string is ever
 * interpolated, so a malicious `method` value can neither overflow the
 * `varchar(200)` subtitle nor land in the ledger — and since the method is
 * validated before this runs, this function cannot be reached with a bad one.
 */
export function withdrawalSubtitle(method: WithdrawalMethod, msisdn10: string): string {
  const meta = WITHDRAWAL_METHOD_META[method];
  return `${meta.label} • ${groupMsisdn(msisdn10)}`;
}

/** Display grouping for an already-validated 10-digit number (pure, no input). */
function groupMsisdn(msisdn10: string): string {
  const d = msisdn10.replace(/\D/g, "");
  if (/^0\d{9}$/.test(d)) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return d;
}
