import "server-only";

import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
// Read-only import of the cookie NAME only, so the admin gate and the customer
// session stay in lockstep without this module changing anything in
// `src/lib/auth.ts`.
import { SESSION_COOKIE } from "@/lib/auth";
import { isSchemaIncompatibleError } from "@/lib/schema-compat";
import {
  adminTestSeamState,
  adminTestSeamUserId,
  isAllowlistedAdminEmail,
} from "@/lib/admin/config";

/**
 * Phase 0 — the FlexiData admin access-control gate.
 *
 * This is the only place that decides whether a request may act as an
 * administrator. Nothing else in the codebase is permitted to make that call.
 *
 * Design rules, in order of importance:
 *
 *  1. **Server-side, always.** Authorization is resolved here, on the server,
 *     from the database. Hiding UI is never the control.
 *  2. **Revocable.** `users.is_admin` is re-read from the database on EVERY
 *     request, and the session row is re-validated on every request. Clearing
 *     the flag (or expiring the session) takes effect on the very next request
 *     — no logout, no cache, no waiting for a token to expire.
 *  3. **Never in the cookie.** The `fd_auth` envelope is a 30-day, signed,
 *     self-contained blob. An admin claim inside it would be unrevocable for a
 *     month, so this gate deliberately ignores `fd_auth` entirely and resolves
 *     the session from `fd_session` against the `sessions` table.
 *  4. **Two independent signals.** `users.is_admin = true` AND the account's
 *     email on the `ADMIN_EMAILS` allowlist (see `./config.ts`).
 *  5. **Fail closed.** Every unknown, ambiguous or degraded state — no session,
 *     expired session, missing user, missing `is_admin` column, unreadable
 *     database, active impersonation seam — denies access.
 *  6. **No oracle.** Denials surface as 404, never 403, so a curious customer
 *     cannot learn that an admin area exists.
 *
 * Explicitly NOT in Phase 0: any dashboard UI, any query over financial data,
 * any write of any kind. This module only answers "is this request an admin?".
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdminActor = {
  userId: number;
  name: string;
  email: string;
  /** The `sessions` row backing this request, or null under the test seam. */
  sessionId: number | null;
  /** How the actor was identified. */
  via: "session" | "test-seam";
};

/**
 * Runtime brand. `BRAND` is a module-private `unique symbol`, so no code
 * outside this file can construct a value of type {@link AdminContext} — the
 * gate functions below are the only source of one. Layer 3 of the defence in
 * depth described in the assessment: an admin query helper can demand an
 * `AdminContext` argument and be statically certain the gate ran.
 */
const BRAND = Symbol("flexidata.admin.context");

export type AdminContext = {
  readonly [BRAND]: true;
  readonly admin: AdminActor;
};

function mintContext(admin: AdminActor): AdminContext {
  return { [BRAND]: true, admin } as const;
}

/** Runtime check that a value really came from this gate. */
export function isAdminContext(value: unknown): value is AdminContext {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
}

/** Why a request was refused administrative access. Logged, never returned. */
export type AdminDenialReason =
  | "no-session-cookie"
  | "session-not-found"
  | "session-expired"
  | "user-not-found"
  | "not-admin"
  | "not-allowlisted"
  | "test-seam-blocked"
  | "schema-missing-is-admin"
  | "database-unavailable";

// ---------------------------------------------------------------------------
// Session resolution — deliberately independent of `getCurrentUser()`
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Resolve the acting user id from the raw session cookie.
 *
 * This intentionally does NOT call `getCurrentUser()`: that helper honours the
 * `FLEXIDATA_TEST_USER_ID` impersonation seam outside production, and the admin
 * gate must decide about that seam itself (see `./config.ts`) rather than
 * inherit it. Resolving the session here also keeps `src/lib/auth.ts` untouched.
 *
 * Read-only: unlike the customer path, this never deletes an expired session
 * row and never touches `last_seen_at`. The gate observes; it does not write.
 */
async function resolveActor(): Promise<
  { ok: true; userId: number; sessionId: number | null; via: AdminActor["via"] } | { ok: false; reason: AdminDenialReason }
> {
  const seam = adminTestSeamState();
  if (seam === "blocked") {
    // The seam is active but not approved for admin use. Refuse outright rather
    // than quietly falling back to cookie auth — the customer app would be
    // acting as the impersonated user while the admin area acted as somebody
    // else, and that split identity is its own hazard.
    return { ok: false, reason: "test-seam-blocked" };
  }
  if (seam === "allowed") {
    const seamUserId = adminTestSeamUserId();
    if (seamUserId === null) return { ok: false, reason: "test-seam-blocked" };
    return { ok: true, userId: seamUserId, sessionId: null, via: "test-seam" };
  }

  let token: string | undefined;
  try {
    const jar = await cookies();
    token = jar.get(SESSION_COOKIE)?.value;
  } catch {
    // Outside a request scope (or cookies unavailable): no session, no access.
    return { ok: false, reason: "no-session-cookie" };
  }
  if (!token) return { ok: false, reason: "no-session-cookie" };

  let rows: { id: number; userId: number; expiresAt: Date }[];
  try {
    rows = await db
      .select({ id: sessions.id, userId: sessions.userId, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.tokenHash, sha256(token)))
      .limit(1);
  } catch (error) {
    console.error("[flexidata:admin] session lookup failed; denying admin access", error);
    return { ok: false, reason: "database-unavailable" };
  }

  const row = rows[0];
  if (!row) return { ok: false, reason: "session-not-found" };

  // Expiry is compared in JS (exactly as the customer session path does) so the
  // check is explicit and does not depend on database time.
  const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
  if (!(expiresAt.getTime() > Date.now())) {
    return { ok: false, reason: "session-expired" };
  }

  return { ok: true, userId: row.userId, sessionId: row.id, via: "session" };
}

// ---------------------------------------------------------------------------
// Admin flag lookup
// ---------------------------------------------------------------------------

type AdminRecord = { id: number; name: string; email: string; isAdmin: boolean };

/**
 * Read the account's identity and `is_admin` flag straight from the database.
 *
 * A deployment whose `users` table predates the `is_admin` column would make
 * this query throw `column "is_admin" does not exist`. The rest of the app
 * degrades around a lagging schema; the admin gate must not — a missing
 * authorization column means "nobody is an admin", never "assume yes". The
 * error is therefore caught and converted into a denial, loudly logged.
 */
async function loadAdminRecord(
  userId: number,
): Promise<{ ok: true; record: AdminRecord } | { ok: false; reason: AdminDenialReason }> {
  try {
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, reason: "user-not-found" };
    return { ok: true, record: { ...row, isAdmin: row.isAdmin === true } };
  } catch (error) {
    if (isSchemaIncompatibleError(error)) {
      console.error(
        "[flexidata:admin] users.is_admin could not be read (the database is missing the column " +
          "or table). Denying all administrative access. Run `npx drizzle-kit push`.",
        error,
      );
      return { ok: false, reason: "schema-missing-is-admin" };
    }
    console.error("[flexidata:admin] admin flag lookup failed; denying admin access", error);
    return { ok: false, reason: "database-unavailable" };
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Structured denial log. Phase 0 has no `admin_audit_logs` table (that is
 * Phase 3 and needs its own migration), so refusals go to stdout — enough to
 * spot probing and to debug a misconfigured allowlist, and consistent with how
 * the rest of the app reports money-safety refusals.
 *
 * Never logs the session token, and never logs an email that was not already
 * known to the server.
 */
function logDenial(reason: AdminDenialReason, detail?: Record<string, unknown>): void {
  // "no session" is the overwhelmingly common case (any signed-out probe) and
  // is not interesting; everything else is.
  if (reason === "no-session-cookie") return;
  console.warn(
    `[flexidata:admin] administrative access denied (${reason})`,
    detail ? JSON.stringify(detail) : "",
  );
}

/**
 * Resolve the admin context for the current request, or `null`.
 *
 * The single source of truth for "is this request an admin?". Safe to call from
 * Server Components, route handlers and server actions.
 */
export async function getAdminContext(): Promise<AdminContext | null> {
  const actor = await resolveActor();
  if (!actor.ok) {
    logDenial(actor.reason);
    return null;
  }

  const loaded = await loadAdminRecord(actor.userId);
  if (!loaded.ok) {
    logDenial(loaded.reason, { userId: actor.userId });
    return null;
  }

  const record = loaded.record;

  // Signal 1 — the database flag. Re-read every request, hence revocable.
  if (!record.isAdmin) {
    logDenial("not-admin", { userId: record.id });
    return null;
  }

  // Signal 2 — the environment allowlist. A database row alone is not enough.
  if (!isAllowlistedAdminEmail(record.email)) {
    logDenial("not-allowlisted", {
      userId: record.id,
      hint: "users.is_admin is true but the account's email is not in ADMIN_EMAILS",
    });
    return null;
  }

  return mintContext({
    userId: record.id,
    name: record.name,
    email: record.email,
    sessionId: actor.sessionId,
    via: actor.via,
  });
}

/** True when the current request is an authorized admin. Never throws. */
export async function isCurrentUserAdmin(): Promise<boolean> {
  return (await getAdminContext()) !== null;
}

/**
 * Server Component / page gate.
 *
 * Renders a 404 for everyone who is not an authorized admin — deliberately the
 * same response an unknown URL produces, so the admin area is not discoverable.
 * `notFound()` throws, so nothing after this call runs for a denied request.
 */
export async function requireAdmin(): Promise<AdminContext> {
  const context = await getAdminContext();
  if (!context) notFound();
  return context;
}

/** The single response shape every denied admin API request receives. */
function adminNotFoundResponse(): Response {
  return Response.json(
    { ok: false, error: "Not found" },
    { status: 404, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

/**
 * Route-handler gate for `/api/admin/**`.
 *
 * **Every** admin route handler must call this as its first statement.
 * `src/proxy.ts` short-circuits all `/api/` paths, so there is no Edge safety
 * net for API routes — the handler's own check is the only thing standing
 * between a customer and admin data.
 *
 * Returns a ready-to-return 404 `Response` (identical for unauthenticated,
 * non-admin, revoked and de-allowlisted callers) instead of throwing, matching
 * the `requireAccount()` convention already used across the app.
 */
export async function requireAdminApi(): Promise<
  { ok: true; context: AdminContext } | { ok: false; response: Response }
> {
  const context = await getAdminContext();
  if (!context) return { ok: false, response: adminNotFoundResponse() };
  return { ok: true, context };
}
