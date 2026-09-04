import "server-only";

/**
 * Phase 0 admin access-control policy — configuration and environment rules.
 *
 * This module holds the *decisions* the admin gate makes about the environment
 * (who may be an admin at all, and whether the development impersonation seam
 * is honoured). It deliberately contains no database access and no request
 * handling so it can be reasoned about — and tested — on its own.
 *
 * Two independent signals are required for administrative access:
 *
 *   1. `users.is_admin = true`, read from the database on EVERY request
 *      (see `src/lib/admin/auth.ts`), which is what makes access revocable.
 *   2. The account's email is present in the `ADMIN_EMAILS` allowlist, which
 *      lives in the deployment environment.
 *
 * Requiring both means neither a database compromise nor an environment
 * compromise is sufficient on its own. Every ambiguous state fails CLOSED.
 */

/** Env values accepted as "true", matching the convention used elsewhere. */
const TRUTHY = ["1", "true", "yes", "on"];

function envFlag(key: string): boolean {
  return TRUTHY.includes((process.env[key] ?? "").trim().toLowerCase());
}

/** Warn at most once per process, so a misconfiguration is loud but not spam. */
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[flexidata:admin] ${message}`);
}

/** Test seam only: forget which warnings have been emitted. */
export function resetAdminConfigWarnings(): void {
  warned.clear();
}

// ---------------------------------------------------------------------------
// Admin email allowlist
// ---------------------------------------------------------------------------

/**
 * Emails permitted to hold administrative access, from `ADMIN_EMAILS`
 * (comma-, semicolon- or whitespace-separated).
 *
 * An empty/unset allowlist yields an EMPTY set, which means **nobody is an
 * admin** — including accounts whose `is_admin` column is already true. That is
 * the fail-closed default: turning on the admin area has to be a deliberate act
 * in the deployment environment, not something a stray database row can do.
 */
export function adminEmailAllowlist(): Set<string> {
  const raw = (process.env.ADMIN_EMAILS ?? "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True when `email` is on the allowlist. Case- and whitespace-insensitive. */
export function isAllowlistedAdminEmail(email: string | null | undefined): boolean {
  const allowlist = adminEmailAllowlist();
  if (allowlist.size === 0) {
    warnOnce(
      "allowlist-empty",
      "ADMIN_EMAILS is not set — administrative access is disabled for every account, " +
        "including users whose is_admin column is true. Set ADMIN_EMAILS to enable the admin area.",
    );
    return false;
  }
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return allowlist.has(normalized);
}

// ---------------------------------------------------------------------------
// Development / staging impersonation seam
// ---------------------------------------------------------------------------

/**
 * `src/lib/auth.ts` honours `FLEXIDATA_TEST_USER_ID` outside production, which
 * lets a harness pin an authenticated user with no cookie and no session row.
 * That is fine for customer-flow tests, but once an admin area exists the same
 * variable would be an *administrative* bypass on any deployment that is not
 * running with `NODE_ENV=production` (previews, staging, a misconfigured host).
 *
 * The admin gate therefore never inherits that seam implicitly:
 *
 *   - `inactive` — no seam in play; normal cookie-backed session resolution.
 *   - `blocked`  — the seam is set but has NOT been explicitly approved for
 *                  admin use. Administrative access is refused outright (the
 *                  gate does not silently fall back to cookie auth, because a
 *                  split identity between the customer app and the admin area
 *                  is itself a hazard).
 *   - `allowed`  — the seam is set AND `FLEXIDATA_TEST_ALLOW_ADMIN` is enabled.
 *                  Only ever reachable outside production.
 *
 * In `NODE_ENV=production` this returns `inactive` unconditionally: the seam is
 * never honoured, and `FLEXIDATA_TEST_ALLOW_ADMIN` cannot re-enable it.
 */
export type TestSeamState = "inactive" | "blocked" | "allowed";

export function adminTestSeamState(): TestSeamState {
  // Hard production lock, checked first and independent of every other flag.
  if (process.env.NODE_ENV === "production") return "inactive";

  const seamUserId = (process.env.FLEXIDATA_TEST_USER_ID ?? "").trim();
  if (!seamUserId) return "inactive";

  if (!envFlag("FLEXIDATA_TEST_ALLOW_ADMIN")) {
    warnOnce(
      "seam-blocked",
      "FLEXIDATA_TEST_USER_ID is set, so admin access is refused for every request. " +
        "The impersonation seam must never become an admin bypass. Set " +
        "FLEXIDATA_TEST_ALLOW_ADMIN=1 to opt in deliberately (non-production only).",
    );
    return "blocked";
  }

  warnOnce(
    "seam-allowed",
    "FLEXIDATA_TEST_ALLOW_ADMIN is enabled: admin authorization is being resolved from " +
      "FLEXIDATA_TEST_USER_ID instead of a real session. Never enable this on a deployment " +
      "that holds real data.",
  );
  return "allowed";
}

/** The impersonated user id, or null when the seam is not usable for admin. */
export function adminTestSeamUserId(): number | null {
  if (adminTestSeamState() !== "allowed") return null;
  const parsed = Number((process.env.FLEXIDATA_TEST_USER_ID ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
