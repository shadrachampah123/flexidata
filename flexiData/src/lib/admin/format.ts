import { money } from "@/lib/format";

/**
 * Formatting helpers shared by the admin pages and the admin API responses.
 *
 * Everything here is deterministic and timezone-stable (UTC): the same value
 * must render identically on the server (first paint) and in the browser
 * (re-render after a filter change), otherwise React reports a hydration
 * mismatch on every table.
 */

/** `GH₵ 1,268.00` — the same money format the customer app uses. */
export function adminMoney(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  return money(amount);
}

/** Signed money for deltas: `+ GH₵ 52.50` / `− GH₵ 52.50`. */
export function adminMoneyDelta(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  const rounded = Math.round(amount * 100) / 100;
  if (rounded === 0) return money(0);
  return money(rounded, { sign: true });
}

const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const DATE_ONLY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
});

/** `04 Sep 2026, 22:31 UTC` (or `—`). Deterministic on server and client. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${DATE_TIME.format(date)} UTC`;
}

/** `04 Sep 2026` (or `—`). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return DATE_ONLY.format(date);
}

/** `2026-09-04` for `<input type="date">` round-tripping. */
export function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

/**
 * Compact age, e.g. `12m`, `3h 05m`, `6d`. Only ever called from the browser
 * (after mount) so it can never disagree with the server-rendered value.
 */
export function formatAge(from: string | null | undefined, now: number): string {
  if (!from) return "—";
  const start = new Date(from).getTime();
  if (Number.isNaN(start)) return "—";
  const seconds = Math.max(0, Math.round((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Whole hours old — used for "stuck" thresholds. */
export function ageHours(from: string | null | undefined, now: number): number | null {
  if (!from) return null;
  const start = new Date(from).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, (now - start) / 3_600_000);
}

/** `1,234` — counts and other plain integers. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-GH");
}
