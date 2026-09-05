import "server-only";

import { parseAmount, parseDateFrom, parseDateTo, parseId, parsePage, parsePageSize } from "@/lib/admin/filters";

/**
 * Shared plumbing for the `/api/admin/**` handlers.
 *
 * There is no shared *authorization* here on purpose: `requireAdminApi()` must
 * be the first statement of every handler, verbatim, so a reviewer can confirm
 * the gate by reading the top of the file rather than by trusting a helper.
 * `src/proxy.ts` short-circuits every `/api/` path, so a handler that forgets
 * the call is completely open — there is no middleware safety net.
 */

/** Never cache an admin response: it is authorization-dependent and live. */
const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

export function adminJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE });
}

/**
 * A failed admin read. The message is generic: SQL text, connection details and
 * schema names stay in the server log and never reach the browser.
 */
export function adminError(label: string, error: unknown): Response {
  console.error(`[flexidata:admin] ${label} failed`, error);
  return Response.json(
    { ok: false, error: "The admin request could not be completed. Check the server logs." },
    { status: 500, headers: NO_STORE },
  );
}

export function searchParamsOf(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

export function strParam(params: URLSearchParams, key: string, max = 60): string | null {
  const value = params.get(key);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function pageParam(params: URLSearchParams): number {
  return parsePage(params.get("page") ?? 1);
}

export function pageSizeParam(params: URLSearchParams): number {
  return parsePageSize(params.get("pageSize") ?? undefined);
}

export function idParam(params: URLSearchParams, key: string): number | null {
  return parseId(params.get(key));
}

export function dateFromParam(params: URLSearchParams, key = "dateFrom"): string | null {
  return parseDateFrom(params.get(key));
}

export function dateToParam(params: URLSearchParams, key = "dateTo"): string | null {
  return parseDateTo(params.get(key));
}

export function amountParam(params: URLSearchParams, key: string): number | null {
  return parseAmount(params.get(key));
}

/** `?a=1` / `?a=true` / `?a` -> true. */
export function boolParam(params: URLSearchParams, key: string): boolean {
  const value = params.get(key);
  if (value === null) return false;
  if (value === "" || value === "1" || value.toLowerCase() === "true") return true;
  return false;
}
