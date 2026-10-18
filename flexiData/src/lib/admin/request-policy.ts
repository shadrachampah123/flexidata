/**
 * Narrow request-boundary policy for existing administrator write routes.
 *
 * This is deliberately not an RBAC or session policy. `requireAdminApi()` still
 * runs first in every handler and remains the authentication/authorization
 * gate. This helper only rejects a request without trustworthy same-origin
 * browser provenance before the handler parses a body or reaches a database
 * write.
 *
 * The shipped callers are same-origin browser components. There are no
 * server-to-server admin write callers in `src/` and no separately documented
 * external admin API contract, so a completely headerless request is not an
 * approved compatibility path. Normal browser POST fetches send `Origin`; the
 * Fetch Metadata / Referer fallbacks cover browsers or test clients that omit
 * it while still proving the request is same-origin.
 */

export type AdminWriteRequestDecision =
  | { ok: true }
  | {
      ok: false;
      reason: "cross-site-fetch" | "origin-mismatch" | "invalid-origin" | "missing-provenance";
    };

function requestOrigin(request: Request): string | null {
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

function matchesRequestOrigin(request: Request, value: string): "match" | "mismatch" | "invalid" {
  const expected = requestOrigin(request);
  if (!expected) return "invalid";
  try {
    return new URL(value).origin === expected ? "match" : "mismatch";
  } catch {
    return "invalid";
  }
}

/**
 * Return the request-boundary decision without constructing a response.
 * Keeping this pure makes the security rule testable without Next.js or a DB.
 */
export function adminWriteRequestDecision(request: Request): AdminWriteRequestDecision {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site" || fetchSite === "cross-origin") {
    return { ok: false, reason: "cross-site-fetch" };
  }

  const originHeader = request.headers.get("origin");
  if (originHeader !== null) {
    // `Origin: null` represents an opaque origin (for example a sandboxed
    // document). It is not an origin we can safely match to the admin request.
    if (originHeader.trim().toLowerCase() === "null") {
      return { ok: false, reason: "invalid-origin" };
    }

    const originResult = matchesRequestOrigin(request, originHeader);
    return originResult === "match"
      ? { ok: true }
      : {
          ok: false,
          reason: originResult === "mismatch" ? "origin-mismatch" : "invalid-origin",
        };
  }

  // An explicit same-origin Fetch Metadata signal is a browser-controlled
  // fallback for clients that omit Origin on a POST. If a Referer is supplied
  // as well, it must agree rather than weakening the decision.
  if (fetchSite === "same-origin") {
    const referer = request.headers.get("referer");
    if (!referer) return { ok: true };
    const refererResult = matchesRequestOrigin(request, referer);
    return refererResult === "match"
      ? { ok: true }
      : {
          ok: false,
          reason: refererResult === "mismatch" ? "origin-mismatch" : "invalid-origin",
        };
  }

  // Older/browser-like clients may omit both Origin and Fetch Metadata but
  // still send a same-origin Referer. It is only a fallback; an absent or
  // malformed provenance signal fails closed.
  const referer = request.headers.get("referer");
  if (referer) {
    const refererResult = matchesRequestOrigin(request, referer);
    return refererResult === "match"
      ? { ok: true }
      : {
          ok: false,
          reason: refererResult === "mismatch" ? "origin-mismatch" : "invalid-origin",
        };
  }

  return { ok: false, reason: "missing-provenance" };
}

/** Generic response used after the admin gate has already authorized the actor. */
export function rejectCrossSiteAdminWrite(request: Request): Response | null {
  const decision = adminWriteRequestDecision(request);
  if (decision.ok) return null;

  console.warn("[flexidata:admin] rejected admin write request", decision.reason);
  return Response.json(
    {
      ok: false,
      error: "This administrator write must originate from the same origin.",
    },
    {
      status: 403,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}
