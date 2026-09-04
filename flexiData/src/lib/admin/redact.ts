/**
 * Phase 1 admin display masking.
 *
 * The dashboard concentrates more personal data on one screen than any other
 * part of FlexiData: names, emails, phone numbers, balances and full purchase
 * histories. Phase 3 will add an audited "reveal" action; until then the rule is
 * simple —
 *
 *   - **List / table views show masked values.** An operator can find the
 *     account (searching happens server-side against the real value) without the
 *     screen becoming a bulk export of customer PII.
 *   - **Single-record detail views show the real value.** When an operator has
 *     deliberately opened one customer, one wallet or one transaction, they need
 *     the actual phone number to do the work.
 *
 * Nothing here is reversible, and nothing here touches storage.
 */

const BULLET = "•";

/**
 * `0244123456` -> `024••••456`. Very short or empty values are fully masked
 * rather than partially exposed.
 */
export function maskPhone(value: unknown): string {
  const raw = (typeof value === "string" ? value : "").trim();
  if (!raw) return "—";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return BULLET.repeat(Math.max(digits.length, 3));
  return `${digits.slice(0, 3)}${BULLET.repeat(4)}${digits.slice(-3)}`;
}

/** `kwame@example.com` -> `k•••@example.com`. */
export function maskEmail(value: unknown): string {
  const raw = (typeof value === "string" ? value : "").trim();
  if (!raw) return "—";
  const at = raw.lastIndexOf("@");
  if (at <= 0) return `${raw.slice(0, 1)}${BULLET.repeat(3)}`;
  const local = raw.slice(0, at);
  const domain = raw.slice(at);
  return `${local.slice(0, 1)}${BULLET.repeat(Math.min(3, Math.max(local.length - 1, 1)))}${domain}`;
}

/** `Kwame Mensah` -> `Kwame M.`. Used only where a full name is not needed. */
export function maskName(value: unknown): string {
  const raw = (typeof value === "string" ? value : "").trim();
  if (!raw) return "—";
  const parts = raw.split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].slice(0, 1)}.`;
}

/**
 * Truncate a free-text provider/gateway message. These columns hold text from
 * external systems and may contain a customer's number or reference; they are
 * rendered verbatim but short, and never as raw JSON payloads.
 */
export function clampText(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
