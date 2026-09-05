/**
 * Shared, PURE parsing for the Phase 1 admin list screens.
 *
 * Every filter and page number the dashboard accepts passes through here —
 * server-side pages and `/api/admin/*` handlers use the same functions, so the
 * JSON API can never accept a filter the page refuses to render (or vice
 * versa). Nothing here touches the database, so it is directly unit-testable.
 *
 * Values are clamped, not rejected: an out-of-range page returns the last valid
 * page rather than an error, and an unknown enum value is dropped instead of
 * being passed through to SQL.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const PAGE_SIZES = [25, 50, 100] as const;
export const MAX_PAGE_SIZE = 100;
/** Hard ceiling so a hand-crafted URL cannot ask for the whole table. */
export const MAX_OFFSET = 100_000;

export type AdminList<T> = {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
};

export function parsePage(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(Math.trunc(parsed), 1), 10_000);
}

export function parsePageSize(value: unknown): number {
  const parsed = Number(value);
  if (!PAGE_SIZES.includes(parsed as (typeof PAGE_SIZES)[number])) return DEFAULT_PAGE_SIZE;
  return parsed;
}

export function offsetFor(page: number, pageSize: number): number {
  const raw = (parsePage(page) - 1) * parsePageSize(pageSize);
  return Math.min(Math.max(raw, 0), MAX_OFFSET);
}

/**
 * Free-text search term, sanitised for a parameterised `ILIKE`.
 *
 * `%`, `_` and `\` are stripped rather than escaped: an operator searching for
 * a customer does not need SQL wildcards, and removing them keeps the pattern
 * safe with no reliance on `ESCAPE` semantics.
 */
export function parseSearch(value: unknown, max = 60): string {
  const raw = (typeof value === "string" ? value : "").trim();
  if (!raw) return "";
  return raw.replace(/[%_\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function likePattern(term: string): string {
  return `%${term}%`;
}

export function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== "string") return null;
  return allowed.includes(value as T) ? (value as T) : null;
}

export function parseId(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(Math.max(parsed, 0) * 100) / 100;
}

const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` -> the first instant of that UTC day, or null. */
export function parseDateFrom(value: unknown): string | null {
  if (typeof value !== "string" || !DATE_INPUT.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `YYYY-MM-DD` -> the last instant of that UTC day, or null. */
export function parseDateTo(value: unknown): string | null {
  if (typeof value !== "string" || !DATE_INPUT.test(value)) return null;
  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Build a query string, dropping empty values so URLs stay readable. */
export function toQueryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/** Raw Next.js search params (`?a=1&a=2` arrives as an array). */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/** First value of a search param, as a trimmed string. */
export function q(params: RawSearchParams, key: string): string {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}
