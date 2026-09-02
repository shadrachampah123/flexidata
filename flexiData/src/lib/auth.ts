import { cookies, headers } from "next/headers";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { eq, desc, and, gt, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, sessions, passwordResets, wallets } from "@/db/schema";
import { ensureSeeded } from "@/lib/seed";
import {
  AUTH_WRITE_INSERT_FIELDS,
  AUTH_WRITE_REQUIRED_COLUMNS,
  buildTableInsert,
  getSchemaCapabilities,
  missingTableColumns,
  type AuthWriteTable,
} from "@/lib/schema-compat";

const SESSION_COOKIE = "fd_session";
// Signed envelope cookie (uid + expiry, HMAC'd). The Edge middleware only
// reads this one; `fd_session` (raw random token, httpOnly) is what the server
// uses to look up the live session row.
const AUTH_COOKIE = "fd_auth";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const RESET_TTL_MS = 1000 * 60 * 60; // 1 hour

function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 16) {
    throw new Error(
      "AUTH_SECRET is missing or too short. Add a random 32+ character string " +
        "to your environment variables (or .env.local).",
    );
  }
  return secret;
}

/**
 * Fail fast when the deployment cannot sign session cookies. The register
 * route calls this *before* creating anything, so a missing secret can never
 * commit an account the visitor then cannot be signed into (an orphaned
 * account whose email reports "already used" on retry). `createSession`
 * re-checks it as belt-and-braces for the login path.
 */
export function assertAuthSecretConfigured(): void {
  getAuthSecret();
}

/** True when AUTH_SECRET is present and long enough (never throws — for /api/health). */
export function hasAuthSecret(): boolean {
  try {
    getAuthSecret();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt — built into Node, no native dependencies)
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// Alias used by account-management routes for readability.
export const verifyPasswordAuth = verifyPassword;

// ---------------------------------------------------------------------------
// Random tokens (session ids, reset codes)
// ---------------------------------------------------------------------------

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// Signed cookie value (HMAC) — lets middleware cheaply reject forged cookies
// on the Edge runtime without touching the database.
// ---------------------------------------------------------------------------

async function hmacSign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getAuthSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Buffer.from(sig).toString("base64url");
}

async function hmacVerify(payload: string, signature: string): Promise<boolean> {
  const expected = await hmacSign(payload);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Verify the signed envelope's signature + expiry (Edge-safe, used by middleware). */
export async function verifyAuthEnvelope(value: string | undefined): Promise<{ uid: number; sid: number } | null> {
  if (!value) return null;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  let parsed: { uid: number; sid: number; exp: number };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.uid !== "number" || typeof parsed.exp !== "number") return null;
  if (parsed.exp < Date.now()) return null;
  if (!(await hmacVerify(payload, sig))) return null;
  return { uid: parsed.uid, sid: parsed.sid };
}

async function buildAuthEnvelope(userId: number, sessionId: number): Promise<string> {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, sid: sessionId, exp: Date.now() + SESSION_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${await hmacSign(payload)}`;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Columns of an auth-lifecycle table that the deployed database does not have
 * (because its migrations lag the code), split into "can be left out of the
 * write" and "the write is impossible without these". Uses the cached schema
 * probe, so it costs nothing after the first request of a process.
 */
async function authTableDrift(table: AuthWriteTable): Promise<{
  skip: Set<string>;
  requiredMissing: string[];
}> {
  const caps = await getSchemaCapabilities();
  return {
    skip: new Set(
      missingTableColumns(caps, table, Object.values(AUTH_WRITE_INSERT_FIELDS[table])),
    ),
    requiredMissing: missingTableColumns(caps, table, AUTH_WRITE_REQUIRED_COLUMNS[table]),
  };
}

/** db.execute returns a QueryResult from the pg driver, a bare array under the test harness. */
function executeRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * Insert into an auth-lifecycle table naming only the columns the database
 * really has, and return the new row's `id`. Drizzle's typed `insert` names
 * every column of the table definition, so a `sessions` / `password_resets`
 * table that is a migration behind rejects it with
 * `column "…" does not exist` — thrown *after* registration had already
 * committed, that is exactly the orphaned-account incident this prevents.
 */
async function insertAuthRow(
  table: AuthWriteTable,
  values: Record<string, unknown>,
  skip: ReadonlySet<string>,
): Promise<number> {
  const statement = buildTableInsert(table, AUTH_WRITE_INSERT_FIELDS[table], [values], skip, "id");
  const row = executeRows(await db.execute(statement))[0];
  const id = row?.id;
  if (id === undefined || id === null) {
    throw new Error(`Inserting into ${table} did not return an id.`);
  }
  return Number(id);
}

/** A database that cannot hold the write at all is reported, not worked around. */
function assertAuthTableWritable(table: AuthWriteTable, requiredMissing: string[]): void {
  if (requiredMissing.length > 0) {
    throw new Error(
      `The database is missing ${table}.${requiredMissing.join(`, ${table}.`)} and cannot store ` +
        `${table === "sessions" ? "a session" : "a password reset"}. ` +
        "Run `npx drizzle-kit push` against this database.",
    );
  }
}

export async function createSession(userId: number): Promise<void> {
  await ensureSeeded();
  // Never write a session row when the cookies it pairs with cannot be signed.
  assertAuthSecretConfigured();

  const token = randomToken();
  const hdrs = await headers();
  const ua = (hdrs.get("user-agent") ?? "").slice(0, 240) || "unknown device";
  const ip =
    hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    hdrs.get("x-real-ip") ||
    null;
  const values = {
    userId,
    tokenHash: sha256(token),
    userAgent: ua,
    ip,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  };

  const { skip, requiredMissing } = await authTableDrift("sessions");
  assertAuthTableWritable("sessions", requiredMissing);
  const degraded = skip.size > 0;
  if (degraded) {
    console.warn(
      `[flexidata] writing a session without ${[...skip].join(", ")} — the database is ` +
        "a migration behind. Run `npx drizzle-kit push` to store them.",
    );
  }

  const sessionId = degraded
    ? await insertAuthRow("sessions", values, skip)
    : (await db.insert(sessions).values(values).returning({ id: sessions.id }))[0].id;

  const jar = await cookies();
  // Raw session token — never exposed to JS.
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  // Signed envelope for the Edge gate.
  jar.set(AUTH_COOKIE, await buildAuthEnvelope(userId, sessionId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export type AuthUser = {
  id: number;
  name: string;
  email: string;
  phone: string;
  referralCode: string;
  referredBy: number | null;
  notifyPromos: boolean;
  notifyTx: boolean;
  isAgent: boolean;
};

async function findUserBySessionToken(token: string): Promise<AuthUser | null> {
  const rows = await db
    .select({ sessionId: sessions.id, expiresAt: sessions.expiresAt, userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.tokenHash, sha256(token)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, row.sessionId));
    return null;
  }

  // Touch last-seen (best effort, never blocks the request — and skipped
  // entirely on a database that has not been migrated for the column yet).
  const { skip } = await authTableDrift("sessions");
  if (!skip.has("last_seen_at")) {
    db.update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, row.sessionId))
      .catch(() => {});
  }

  return getAuthUserById(row.userId);
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  // Test seam: outside production the harness (which invokes route handlers
  // directly, without Next's cookie runtime) can pin an authenticated user id
  // via FLEXIDATA_TEST_USER_ID. Never honoured in production.
  if (process.env.NODE_ENV !== "production" && process.env.FLEXIDATA_TEST_USER_ID) {
    return getAuthUserById(Number(process.env.FLEXIDATA_TEST_USER_ID));
  }
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const user = await findUserBySessionToken(token);
    if (!user) {
      jar.delete(SESSION_COOKIE);
      jar.delete(AUTH_COOKIE);
      return null;
    }
    return user;
  } catch {
    return null;
  }
}

/** Resolve the AuthUser for an id directly (test seam / internal callers). */
export async function getAuthUserById(userId: number): Promise<AuthUser | null> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      referralCode: users.referralCode,
      referredBy: users.referredBy,
      notifyPromos: users.notifyPromos,
      notifyTx: users.notifyTx,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const walletRows = await db
    .select({ isAgent: wallets.isAgent })
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .limit(1);
  return { ...row, isAgent: walletRows[0]?.isAgent ?? false };
}

export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token))).catch(() => {});
  }
  jar.delete(SESSION_COOKIE);
  jar.delete(AUTH_COOKIE);
}

export async function destroyOtherSessions(userId: number): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return;
  const currentHash = sha256(token);
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, currentHash)))
    .catch(() => {});
}

export type SessionInfo = {
  id: number;
  userAgent: string;
  ip: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  current: boolean;
};

export async function listSessions(userId: number): Promise<SessionInfo[]> {
  const jar = await cookies();
  const currentToken = jar.get(SESSION_COOKIE)?.value ?? "";
  const currentHash = currentToken ? sha256(currentToken) : null;

  const { skip, requiredMissing } = await authTableDrift("sessions");
  assertAuthTableWritable("sessions", requiredMissing);

  if (skip.size === 0) {
    const rows = await db
      .select({
        id: sessions.id,
        tokenHash: sessions.tokenHash,
        userAgent: sessions.userAgent,
        ip: sessions.ip,
        lastSeenAt: sessions.lastSeenAt,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.lastSeenAt));
    return rows.map((r) => ({
      id: r.id,
      userAgent: r.userAgent ?? "unknown device",
      ip: r.ip,
      lastSeenAt: r.lastSeenAt,
      createdAt: r.createdAt,
      current: r.tokenHash === currentHash,
    }));
  }

  // Drifted `sessions` table: name only the columns the database really has
  // (a typed select would name missing ones and throw), and apply the expiry
  // filter / ordering in JS so the WHERE clause stays trivially portable.
  const wanted = ["id", "token_hash", "user_agent", "ip", "last_seen_at", "created_at", "expires_at"].filter(
    (column) => !skip.has(column),
  );
  const rows = executeRows(
    await db.execute(
      sql`select ${sql.join(
        wanted.map((column) => sql.identifier(column)),
        sql`, `,
      )} from sessions where user_id = ${userId}`,
    ),
  );

  const now = Date.now();
  const toDate = (value: unknown): Date | null => (value == null ? null : new Date(value as string | Date));
  return rows
    .filter((row) => (toDate(row.expires_at)?.getTime() ?? 0) > now)
    .map((row) => {
      const createdAt = toDate(row.created_at) ?? new Date(0);
      const lastSeenAt = toDate(row.last_seen_at) ?? createdAt;
      return {
        id: Number(row.id),
        userAgent: (row.user_agent as string | null) ?? "unknown device",
        ip: (row.ip as string | null) ?? null,
        lastSeenAt,
        createdAt,
        current: currentHash !== null && row.token_hash === currentHash,
      };
    })
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

export async function deleteSessionById(userId: number, sessionId: number): Promise<void> {
  await db.delete(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export type ResetRecord = { token: string; expiresAt: Date };

export async function createPasswordReset(email: string): Promise<ResetRecord | null> {
  await ensureSeeded();
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  // Always return null silently for unknown emails (no account enumeration).
  if (!user) return null;

  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  const values = { userId: user.id, tokenHash: sha256(token), expiresAt };

  const { skip, requiredMissing } = await authTableDrift("password_resets");
  assertAuthTableWritable("password_resets", requiredMissing);
  if (skip.size > 0) {
    console.warn(
      `[flexidata] writing a password reset without ${[...skip].join(", ")} — the database is ` +
        "a migration behind. Run `npx drizzle-kit push` to store them.",
    );
    await insertAuthRow("password_resets", values, skip);
  } else {
    await db.insert(passwordResets).values(values);
  }
  return { token, expiresAt };
}

/** Consume a reset token and return the user id it belongs to, or null. */
export async function consumePasswordReset(
  token: string,
): Promise<{ userId: number } | null> {
  const digest = sha256(token);
  const { skip, requiredMissing } = await authTableDrift("password_resets");
  assertAuthTableWritable("password_resets", requiredMissing);

  if (skip.has("used_at")) {
    // A schema without `used_at` cannot mark tokens consumed: honour the token
    // up to its expiry rather than failing the reset — the column ships with
    // the very next migration, and a blocked reset is the worse failure.
    const rows = executeRows(
      await db.execute(
        sql`select id, user_id, expires_at from password_resets where token_hash = ${digest} limit 1`,
      ),
    );
    const row = rows[0];
    if (!row) return null;
    if (new Date(row.expires_at as string | Date).getTime() < Date.now()) return null;
    console.warn(
      "[flexidata] password_resets.used_at is missing — reset tokens cannot be marked used " +
        "until `npx drizzle-kit push` runs.",
    );
    return { userId: Number(row.user_id) };
  }

  const rows = await db
    .select({
      id: passwordResets.id,
      userId: passwordResets.userId,
      usedAt: passwordResets.usedAt,
      expiresAt: passwordResets.expiresAt,
    })
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, digest))
    .limit(1);
  const reset = rows[0];
  if (!reset) return null;
  if (reset.usedAt) return null;
  if (reset.expiresAt.getTime() < Date.now()) return null;

  await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(eq(passwordResets.id, reset.id));
  return { userId: reset.userId };
}

// Cookie names used by the middleware gate.
export { SESSION_COOKIE, AUTH_COOKIE };

/** A unique referral code like "FD-KWAME-4F8A". */
export function generateReferralCode(name: string): string {
  const base = name
    .replace(/[^A-Za-z]/g, "")
    .slice(0, 5)
    .toUpperCase();
  const suffix = randomBytes(3).toString("hex").toUpperCase().slice(0, 4);
  return `FD-${base || "USER"}-${suffix}`;
}

export async function setUserPassword(userId: number, newPassword: string): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash: hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function findUnusedResetForUser(userId: number): Promise<boolean> {
  const { skip, requiredMissing } = await authTableDrift("password_resets");
  assertAuthTableWritable("password_resets", requiredMissing);

  if (skip.size > 0) {
    // Drifted schema: name only columns that exist and filter in JS.
    const rows = executeRows(
      await db.execute(sql`select expires_at from password_resets where user_id = ${userId}`),
    );
    return rows.some(
      (row) => new Date(row.expires_at as string | Date).getTime() > Date.now(),
    );
  }

  const rows = await db
    .select({ id: passwordResets.id })
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.userId, userId),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
