/**
 * Narrow request-boundary policy for existing administrator write routes.
 *
 * This is deliberately not an RBAC or session policy. `requireAdminApi()` still
 * runs first in every handler and remains the authentication/authorization
 * gate. This helper only rejects an explicitly cross-site browser request
 * before the handler parses a body or reaches a database write.
 *
 * We do not invent a new allowlist of origins here: the request URL is the
 * origin the server is handling, and the browser's `Origin` / `Sec-Fetch-Site`
 * headers are compared with that URL. Missing headers are accepted for
 * same-origin server-to-server callers and existing operational clients; an
 * explicit cross-site signal is never accepted.
 */

export type AdminWriteRequestDecision =
  | { ok: true }
  | { ok: false; reason: "cross-site-fetch" | "origin-mismatch" | "invalid-origin" };

/**
 * Return the request-boundary decision without constructing a response.
 * Keeping this pure makes the security rule testable without Next.js or a DB.
 */
export function adminWriteRequestDecision(request: Request): AdminWriteRequestDecision {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") {
    return { ok: false, reason: "cross-site-fetch" };
  }

  const originHeader = request.headers.get("origin");
  if (!originHeader) return { ok: true };

  // `Origin: null` represents an opaque origin (for example a sandboxed
  // document). It is not an origin we can safely match to the admin request.
  if (originHeader.trim().toLowerCase() === "null") {
    return { ok: false, reason: "invalid-origin" };
  }

  try {
    const requestOrigin = new URL(request.url).origin;
    const origin = new URL(originHeader).origin;
    return origin === requestOrigin
      ? { ok: true }
      : { ok: false, reason: "origin-mismatch" };
  } catch {
    return { ok: false, reason: "invalid-origin" };
  }
}

/** Generic response used after the admin gate has already authorized the actor. */
export function rejectCrossSiteAdminWrite(request: Request): Response | null {
  const decision = adminWriteRequestDecision(request);
  if (decision.ok) return null;

  console.warn("[flexidata:admin] rejected cross-site write request", decision.reason);
  return Response.json(
    {
      ok: false,
      error: "This administrator write must originate from the same site.",
    },
    {
      status: 403,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}
