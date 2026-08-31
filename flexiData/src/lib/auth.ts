import { cookies, headers } from "next/headers";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { eq, desc, and, gt, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { users, sessions, passwordResets, wallets } from "@/db/schema";
import { ensureSeeded } from "@/lib/seed";

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

export async function createSession(userId: number): Promise<void> {
  await ensureSeeded();
  const token = randomToken();
  const hdrs = await headers();
  const ua = (hdrs.get("user-agent") ?? "").slice(0, 240) || "unknown device";
  const ip =
    hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    hdrs.get("x-real-ip") ||
    null;

  const sessionRow = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: sha256(token),
      userAgent: ua,
      ip,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })
    .returning({ id: sessions.id });

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
  jar.set(AUTH_COOKIE, await buildAuthEnvelope(userId, sessionRow[0].id), {
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

  // Touch last-seen (best effort, never blocks the request).
  db.update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.id, row.sessionId))
    .catch(() => {});

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
  const currentHash = currentToken ? sha256(currentToken) : null;
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.userAgent ?? "unknown device",
    ip: r.ip,
    lastSeenAt: r.lastSeenAt,
    createdAt: r.createdAt,
    current: r.tokenHash === currentHash,
  }));
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
  await db.insert(passwordResets).values({
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt,
  });
  return { token, expiresAt };
}

/** Consume a reset token and return the user id it belongs to, or null. */
export async function consumePasswordReset(
  token: string,
): Promise<{ userId: number } | null> {
  const rows = await db
    .select({
      id: passwordResets.id,
      userId: passwordResets.userId,
      usedAt: passwordResets.usedAt,
      expiresAt: passwordResets.expiresAt,
    })
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, sha256(token)))
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
