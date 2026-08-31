import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentProfiles, users, wallets } from "@/db/schema";
import { generateReferralCode, hashPassword, verifyPassword } from "@/lib/auth";
import { isValidPhone, phoneDigits } from "@/lib/format";

export type RegistrationInput = {
  name: string;
  email: string;
  phone: string;
  password: string;
  referralCode?: string | null;
};

export type RegistrationResult =
  | { ok: true; userId: number; walletId: number }
  | { ok: false; error: string };

/** Basic email shape check (full validation happens on login attempt). */
export function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Normalize a Ghanaian phone number to the 10-digit 0XX form used in-app. */
export function normalizePhone(value: string): string | null {
  const digits = phoneDigits(value.replace(/\s/g, ""));
  // 233XXXXXXXXX (international) -> 0XXXXXXXXX
  if (digits.startsWith("233") && digits.length === 12) {
    return `0${digits.slice(3)}`;
  }
  if (digits.length === 10 && digits.startsWith("0")) return digits;
  if (digits.length === 9 && !digits.startsWith("0")) return `0${digits}`;
  return null;
}

export function passwordStrength(password: string): { ok: boolean; error: string | null } {
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters" };
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    return { ok: false, error: "Password needs both letters and numbers" };
  }
  return { ok: true, error: null };
}

/**
 * Create a real user account + wallet (and the matching agent-profile slot the
 * agent program expects). Every account starts at GH₵ 0.00 and funds its wallet
 * via MoMo/card — exactly like DataPlug, RemaData and MyDataBundle onboarding.
 */
export async function registerUser(input: RegistrationInput): Promise<RegistrationResult> {
  const name = input.name.trim().replace(/\s+/g, " ");
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const password = input.password;

  if (name.length < 2) return { ok: false, error: "Enter your full name" };
  if (!isLikelyEmail(email)) return { ok: false, error: "Enter a valid email address" };
  if (!phone || !isValidPhone(phone)) {
    return { ok: false, error: "Enter a valid Ghanaian phone number (e.g. 024 123 4567)" };
  }
  const strength = passwordStrength(password);
  if (!strength.ok) return { ok: false, error: strength.error ?? "Weak password" };

  // Referral code -> referring user (optional).
  let referredBy: number | null = null;
  if (input.referralCode && input.referralCode.trim()) {
    const code = input.referralCode.trim().toUpperCase();
    const referrer = await db
      .select({ id: users.id, referralCode: users.referralCode })
      .from(users)
      .where(eq(users.referralCode, code))
      .limit(1);
    if (!referrer[0]) {
      return { ok: false, error: "That referral code doesn't exist" };
    }
    referredBy = referrer[0].id;
  }

  // Uniqueness checks with friendly messages.
  const existingEmail = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existingEmail[0]) return { ok: false, error: "An account with this email already exists" };

  const existingPhone = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1);
  if (existingPhone[0]) {
    return { ok: false, error: "An account with this phone number already exists" };
  }

  // Generate a unique referral code (retry on the astronomically unlikely clash).
  let referralCode = generateReferralCode(name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.referralCode, referralCode))
      .limit(1);
    if (!clash[0]) break;
    referralCode = generateReferralCode(`${name}${attempt}`);
  }

  const inserted = await db
    .insert(users)
    .values({
      name,
      email,
      phone,
      passwordHash: hashPassword(password),
      referralCode,
      referredBy,
    })
    .returning({ id: users.id });

  const userId = inserted[0].id;

  const walletInserted = await db
    .insert(wallets)
    .values({
      userId,
      name,
      number: phone,
      balance: "0.00",
      points: 0,
      referralCode,
    })
    .returning({ id: wallets.id });

  // Agent profile slot (kept in sync with the wallet until the user activates).
  await db
    .insert(agentProfiles)
    .values({ walletId: walletInserted[0].id, tier: "Starter", referralCode })
    .onConflictDoNothing();

  return { ok: true, userId, walletId: walletInserted[0].id };
}

/** Keep the wallet name/number in sync when the user edits their profile. */
export async function syncWalletIdentity(userId: number, name: string, phone: string): Promise<void> {
  await db
    .update(wallets)
    .set({ name, number: phone })
    .where(eq(wallets.userId, userId));
}

export async function bumpUserUpdatedAt(userId: number): Promise<void> {
  await db
    .update(users)
    .set({ updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function countUsers(): Promise<number> {
  const rows = await db.execute<{ c: string }>(sql`select count(*)::text as c from users`);
  return Number(rows.rows[0]?.c ?? 0);
}

/** Look a user up by email address or phone number (login identifier). */
export async function getUserByHumanId(identifier: string): Promise<{
  id: number;
  name: string;
  passwordHash: string;
} | null> {
  const id = identifier.trim();
  const phone = normalizePhone(id);
  const email = isLikelyEmail(id) ? normalizeEmail(id) : null;

  const rows = await db
    .select({ id: users.id, name: users.name, passwordHash: users.passwordHash })
    .from(users)
    .where(email ? eq(users.email, email) : eq(users.phone, phone ?? id))
    .limit(1);
  return rows[0] ?? null;
}

export async function verifyLogin(
  identifier: string,
  password: string,
): Promise<{ id: number; name: string } | null> {
  const user = await getUserByHumanId(identifier);
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return { id: user.id, name: user.name };
}
