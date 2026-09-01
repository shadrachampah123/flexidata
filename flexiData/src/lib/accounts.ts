import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentProfiles, users, wallets } from "@/db/schema";
import { generateReferralCode, hashPassword, verifyPassword } from "@/lib/auth";
import { ensureSeeded } from "@/lib/seed";
import { isValidPhone } from "@/lib/format";
import {
  SIGNUP_INSERT_FIELDS,
  SIGNUP_REQUIRED_COLUMNS,
  SIGNUP_TABLES,
  buildTableInsert,
  getSchemaCapabilities,
  missingTableColumns,
} from "@/lib/schema-compat";

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

/**
 * Normalize a Ghanaian phone number to the 10-digit 0XX form used in-app.
 * Accepts the local 0XX / 9-digit spellings and the international ones a user
 * is likely to type: +233, 233 and 00233.
 *
 * This deliberately does not go through `phoneDigits`, which caps its result at
 * 10 digits and would silently truncate a 12-digit 233 number into something
 * that then fails validation ("Enter a valid Ghanaian phone number").
 */
export function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  // +233XXXXXXXXX / 233XXXXXXXXX -> 0XXXXXXXXX
  if (digits.startsWith("233") && digits.length === 12) return `0${digits.slice(3)}`;
  // 00233XXXXXXXXX -> 0XXXXXXXXX
  if (digits.startsWith("00233") && digits.length === 14) return `0${digits.slice(5)}`;
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
 * Turn a Postgres unique violation (SQLSTATE 23505) raised while creating an
 * account into the same human-readable message the pre-insert checks return, so
 * a concurrent signup never surfaces as a bare "Something went wrong".
 */
function uniqueViolationMessage(error: unknown): string | null {
  // Drizzle wraps the driver error ("Failed query: ..."), so walk the `cause`
  // chain to reach the Postgres error that carries the SQLSTATE + constraint.
  let current = error as { code?: string; constraint?: string; cause?: unknown } | null;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code === "23505") {
      const constraint = current.constraint ?? "";
      if (constraint.includes("email")) return "An account with this email already exists";
      if (constraint.includes("phone") || constraint.includes("number")) {
        return "An account with this phone number already exists";
      }
      if (constraint.includes("referral_code")) {
        return "That referral code is already taken. Please try again.";
      }
      return "An account with these details already exists";
    }
    current = current.cause as typeof current;
  }
  return null;
}

type SignupTable = (typeof SIGNUP_TABLES)[number];

/** The transaction handle Drizzle hands to `db.transaction(...)`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** `db.execute` returns a `QueryResult` here, and a bare array under the test harness. */
function resultRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * Insert a row naming only the columns the database actually has, and return
 * its `id`.
 *
 * Drizzle's typed `insert` always names every column of the table definition,
 * so a table one migration behind rejects it with
 * `column "…" does not exist` — which is exactly how a migration that never
 * reached production turned every sign-up into a bare
 * "Something went wrong. Please try again.".
 */
async function insertReturningId(
  tx: Tx,
  table: SignupTable,
  values: Record<string, unknown>,
  skip: ReadonlySet<string>,
): Promise<number> {
  const statement = buildTableInsert(table, SIGNUP_INSERT_FIELDS[table], [values], skip, "id");
  const row = resultRows(await tx.execute(statement))[0];
  const id = row?.id;
  if (id === undefined || id === null) {
    throw new Error(`Inserting into ${table} did not return an id.`);
  }
  return Number(id);
}

/**
 * Check the tables sign-up writes to before writing to them.
 *
 * Optional columns (nullable, or `NOT NULL` with a database default) are simply
 * left out of the insert when the database does not have them yet. Required
 * ones cannot be, so a database missing those is reported instead of being
 * worked around — otherwise the failure just moves and stays just as opaque.
 */
async function signupColumnDrift(): Promise<{
  skip: Record<SignupTable, Set<string>>;
  missing: string[];
  requiredMissing: string[];
}> {
  const caps = await getSchemaCapabilities();
  const skip = {} as Record<SignupTable, Set<string>>;
  const missing: string[] = [];
  const requiredMissing: string[] = [];

  for (const table of SIGNUP_TABLES) {
    const absent = new Set(
      missingTableColumns(caps, table, Object.values(SIGNUP_INSERT_FIELDS[table])),
    );
    skip[table] = absent;
    for (const column of absent) missing.push(`${table}.${column}`);
    for (const column of missingTableColumns(caps, table, SIGNUP_REQUIRED_COLUMNS[table])) {
      requiredMissing.push(`${table}.${column}`);
    }
  }

  return { skip, missing, requiredMissing };
}

/**
 * Create a real user account + wallet (and the matching agent-profile slot the
 * agent program expects). Every account starts at GH₵ 0.00 and funds its wallet
 * via MoMo/card — exactly like DataPlug, RemaData and MyDataBundle onboarding.
 */
export async function registerUser(input: RegistrationInput): Promise<RegistrationResult> {
  // Runs the startup seed and, with it, the referral-index repair. This has to
  // happen before the insert below: on a cold process the register route would
  // otherwise reach the unique index it is meant to have replaced. Memoized, so
  // it costs one extra await after the first call.
  await ensureSeeded();

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

  // All three inserts share one transaction. A user row committed without its
  // wallet leaves that email and phone permanently blocked ("already exists")
  // with no way for the visitor to finish signing up.
  const { skip, missing, requiredMissing } = await signupColumnDrift();

  if (requiredMissing.length > 0) {
    console.error(
      `[flexidata] sign-up is blocked: the database is missing ${requiredMissing.join(", ")}. ` +
        "Run `npx drizzle-kit push` against this database.",
    );
    return {
      ok: false,
      error: "Account setup is temporarily unavailable. Please try again shortly.",
    };
  }

  // A database that has not been migrated for these columns yet must fail
  // loudly rather than silently, but it must not take sign-up down with it.
  const degraded = missing.length > 0;
  if (degraded) {
    console.warn(
      `[flexidata] sign-up is running against an out-of-date schema (${missing.join(", ")} missing); ` +
        "those columns are being skipped. Run `npx drizzle-kit push` to store them.",
    );
  }

  try {
    const created = await db.transaction(async (tx) => {
      // Fast path: a fully migrated database keeps using the typed Drizzle
      // insert. Only a drifted one falls back to naming columns explicitly,
      // which is the only way to write to a table that is a migration behind.
      const userId = degraded
        ? await insertReturningId(
            tx,
            "users",
            {
              name,
              email,
              phone,
              passwordHash: hashPassword(password),
              referralCode,
              referredBy,
            },
            skip.users,
          )
        : (
            await tx
              .insert(users)
              .values({
                name,
                email,
                phone,
                passwordHash: hashPassword(password),
                referralCode,
                referredBy,
              })
              .returning({ id: users.id })
          )[0].id;

      const walletId = degraded
        ? await insertReturningId(
            tx,
            "wallets",
            { userId, name, number: phone, balance: "0.00", points: 0, referralCode },
            skip.wallets,
          )
        : (
            await tx
              .insert(wallets)
              .values({
                userId,
                name,
                number: phone,
                balance: "0.00",
                points: 0,
                referralCode,
              })
              .returning({ id: wallets.id })
          )[0].id;

      // Agent profile slot (kept in sync with the wallet until the user activates).
      if (degraded) {
        const statement = buildTableInsert(
          "agent_profiles",
          SIGNUP_INSERT_FIELDS.agent_profiles,
          [{ walletId, tier: "Starter", referralCode }],
          skip.agent_profiles,
        );
        await tx.execute(sql`${statement} on conflict do nothing`);
      } else {
        await tx
          .insert(agentProfiles)
          .values({ walletId, tier: "Starter", referralCode })
          .onConflictDoNothing();
      }

      return { userId, walletId };
    });

    return { ok: true, ...created };
  } catch (error) {
    // Two people submitting the same email/phone at the same instant both pass
    // the pre-checks above; the database constraint is the real gate. Report it
    // the same way the pre-checks do instead of as a generic 500.
    const conflict = uniqueViolationMessage(error);
    if (conflict) return { ok: false, error: conflict };
    throw error;
  }
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
