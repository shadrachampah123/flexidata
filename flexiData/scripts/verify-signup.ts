/**
 * Regression harness for the account-creation flow.
 *
 * The in-memory simulator behind `verify:schema-compat` does not model unique
 * constraints, so it cannot catch the class of bug this harness covers (a
 * UNIQUE index on `users.referred_by` rejected every signup after the first one
 * that used a given referral code). This script therefore talks to a real
 * PostgreSQL database.
 *
 * Requirements:
 *   - DATABASE_URL pointing at a scratch database whose schema has been pushed
 *     (`npx drizzle-kit push`)
 *   - AUTH_SECRET set to any 32+ character string
 *
 * It creates only its own accounts (emails/phones are suffixed with a random
 * tag) and deletes them again on the way out.
 *
 * Run with: npm run verify:signup
 */
import { inArray, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { agentProfiles, users, wallets } from "@/db/schema";
import { normalizePhone, registerUser } from "@/lib/accounts";
import { repairReferrerIndex } from "@/lib/seed";
import { groupPhone } from "@/lib/format";

const TAG = Math.random().toString(36).slice(2, 8).toUpperCase();

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
}

/** A 10-digit 0XX number that is very unlikely to collide with real data. */
function phoneFrom(seed: number): string {
  const tail = String(1000000 + seed * 7919).slice(-7);
  return `024${tail}`;
}

/** The current definition of the referral index, or null when it is absent. */
async function referrerIndexDef(): Promise<string | null> {
  const rows = await db.execute<{ indexdef: string }>(
    sql`select indexdef from pg_indexes where indexname = 'users_referred_by_idx'`,
  );
  return rows.rows[0]?.indexdef ?? null;
}

async function main() {
  console.log(`\nsignup harness — tag ${TAG}\n`);

  // --- Pure helpers -------------------------------------------------------
  check("groupPhone keeps all 12 digits of a +233 number", groupPhone("+233247778888") === "233 24 777 8888", groupPhone("+233247778888"));
  check("normalizePhone(+233…) -> 0XX form", normalizePhone("+233247778888") === "0247778888", normalizePhone("+233247778888"));
  check("normalizePhone(00233…) -> 0XX form", normalizePhone("00233247778888") === "0247778888", normalizePhone("00233247778888"));
  check("normalizePhone(0XX) unchanged", normalizePhone("024 123 4567") === "0241234567", normalizePhone("024 123 4567"));
  check("normalizePhone rejects a truncated 233 number", normalizePhone("2332477788") === null, normalizePhone("2332477788"));

  // registerUser lowercases addresses, so build them lowercase to begin with.
  const email = (n: string) => `${n}-${TAG.toLowerCase()}@flexidata-verify.test`;
  const createdEmails: string[] = [];

  // --- Self-healing index repair ------------------------------------------
  // Runs before this harness creates any referred users: re-breaking the index
  // requires a table with no duplicate referred_by values. Deployments that
  // cannot run `npx drizzle-kit push` depend on this repair happening on boot.
  await db.execute(sql`drop index if exists users_referred_by_idx`);
  let reBroken = true;
  try {
    await db.execute(sql`create unique index users_referred_by_idx on users (referred_by)`);
  } catch {
    // Duplicate referrals already exist, so Postgres refuses the unique index.
    // That is the post-fix state — nothing left to repair.
    reBroken = false;
    await db.execute(
      sql`create index if not exists users_referred_by_idx on users (referred_by)`,
    );
    console.log("  SKIP  cannot re-break the index (duplicate referrals already present)");
  }
  if (reBroken) {
    check(
      "precondition: index is UNIQUE again",
      /unique/i.test((await referrerIndexDef()) ?? ""),
      await referrerIndexDef(),
    );

    await repairReferrerIndex();
    const healed = await referrerIndexDef();
    check(
      "repairReferrerIndex swaps UNIQUE for a plain index",
      !!healed && !/unique/i.test(healed),
      healed,
    );

    await repairReferrerIndex();
    check(
      "repair is idempotent (second call is a no-op)",
      (await referrerIndexDef()) === healed,
      await referrerIndexDef(),
    );
  }

  // --- The referrer -------------------------------------------------------
  const referrerEmail = email("referrer");
  createdEmails.push(referrerEmail);
  const referrer = await registerUser({
    name: "Referrer One",
    email: referrerEmail,
    phone: phoneFrom(1),
    password: "Passw0rd123",
  });
  check("referrer signup ok", referrer.ok, referrer);
  if (!referrer.ok) return finish();

  const codeRows = await db
    .select({ referralCode: users.referralCode })
    .from(users)
    .where(inArray(users.email, [referrerEmail]))
    .limit(1);
  const code = codeRows[0].referralCode;

  // --- Three people sharing ONE referral code -----------------------------
  // This is the case that used to fail with
  // `duplicate key value violates unique constraint "users_referred_by_idx"`.
  for (const [i, name] of ["friend-a", "friend-b", "friend-c"].entries()) {
    const friendEmail = email(name);
    createdEmails.push(friendEmail);
    const res = await registerUser({
      name: `Friend ${i + 1}`,
      email: friendEmail,
      phone: phoneFrom(i + 2),
      password: "Passw0rd123",
      referralCode: code,
    });
    check(`signup #${i + 2} with the same referral code ok`, res.ok, res);
  }

  const referred = await db
    .select({ id: users.id, referredBy: users.referredBy })
    .from(users)
    .where(inArray(users.email, createdEmails));
  const friends = referred.filter((r) => r.referredBy !== null);
  check("all three friends point at the same referrer", friends.length === 3, friends);
  check(
    "referred_by is not unique-constrained",
    new Set(friends.map((f) => f.referredBy)).size === 1,
    friends.map((f) => f.referredBy),
  );

  // --- International numbers ---------------------------------------------
  const intlEmail = email("intl");
  createdEmails.push(intlEmail);
  const intlPhone = phoneFrom(9);
  const intl = await registerUser({
    name: "Intl Number",
    email: intlEmail,
    phone: `+233${intlPhone.slice(1)}`,
    password: "Passw0rd123",
  });
  check("+233 signup ok (was rejected as an invalid number)", intl.ok, intl);
  if (intl.ok) {
    const stored = await db
      .select({ phone: users.phone, number: wallets.number })
      .from(users)
      .leftJoin(wallets, sql`${wallets.userId} = ${users.id}`)
      .where(inArray(users.email, [intlEmail]))
      .limit(1);
    check("+233 stored in the local 0XX form", stored[0]?.phone === intlPhone, stored[0]);
  }

  // --- Duplicate handling -------------------------------------------------
  const dup = await registerUser({
    name: "Duplicate Email",
    email: referrerEmail,
    phone: phoneFrom(20),
    password: "Passw0rd123",
  });
  check(
    "duplicate email is a friendly 400, not a crash",
    !dup.ok && dup.error === "An account with this email already exists",
    dup,
  );

  // --- Atomicity ----------------------------------------------------------
  // Occupy the wallet-number slot so the wallet insert fails half way through
  // signup. Before the transaction fix this committed the user row and left
  // that email permanently unusable.
  const blockedPhone = phoneFrom(30);
  const blockedEmail = email("blocked");
  await db
    .insert(wallets)
    .values({ name: "Squatter", number: blockedPhone, balance: "0.00", points: 0 });

  const blocked = await registerUser({
    name: "Blocked Halfway",
    email: blockedEmail,
    phone: blockedPhone,
    password: "Passw0rd123",
  });
  check(
    "mid-signup wallet conflict returns a friendly message",
    !blocked.ok && blocked.error === "An account with this phone number already exists",
    blocked,
  );
  const orphans = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, [blockedEmail]));
  check("failed signup rolls back (no orphan user row)", orphans.length === 0, orphans);

  await db.delete(wallets).where(sql`${wallets.number} = ${blockedPhone} and ${wallets.userId} is null`);

  // The same email must still be usable once the conflict is gone.
  const retry = await registerUser({
    name: "Blocked Halfway",
    email: blockedEmail,
    phone: blockedPhone,
    password: "Passw0rd123",
  });
  createdEmails.push(blockedEmail);
  check("email still usable after the conflict is removed", retry.ok, retry);

  return finish();
}

async function finish() {
  // Clean up everything this run created.
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`${users.email} like ${"%@flexidata-verify.test"}`);
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    const walletRows = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(inArray(wallets.userId, ids));
    const walletIds = walletRows.map((w) => w.id);
    if (walletIds.length > 0) {
      await db.delete(agentProfiles).where(inArray(agentProfiles.walletId, walletIds));
    }
    await db.delete(wallets).where(inArray(wallets.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  }
  await db.execute(sql`delete from wallets where name = 'Squatter' and user_id is null`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed\n`);
  process.exitCode = passed === results.length ? 0 : 1;
  await pool.end();
}

main().catch(async (e) => {
  console.error("signup harness crashed:", e);
  await finish();
  // A crash must fail the run even if every check so far passed.
  process.exitCode = 1;
});
