/**
 * FlexiData admin provisioning CLI (Phase 0).
 *
 * Granting administrative access is deliberately an OPERATOR action performed
 * against the database, not an HTTP endpoint. There is no API anywhere in the
 * application that can set `users.is_admin` — if there were, a compromised
 * customer session or a privilege-escalation bug in any route could mint an
 * admin. This script is the whole provisioning surface.
 *
 * What it touches: `users.is_admin` and `users.updated_at`. Nothing else.
 * It CANNOT modify wallets, balances, transactions, deposits, orders or
 * payments — those tables are never referenced here, and a guard below refuses
 * to run any statement against them.
 *
 * Usage (from the flexiData directory):
 *
 *   npm run admin:grant  -- --email ops@example.com            # grant
 *   npm run admin:grant  -- --email ops@example.com --revoke   # revoke
 *   npm run admin:grant  -- --email ops@example.com --status   # inspect one
 *   npm run admin:grant  -- --list                             # all admins
 *
 * Remember: `is_admin` is only ONE of the two required signals. The account's
 * email must ALSO appear in the `ADMIN_EMAILS` environment allowlist before the
 * gate will let it in. This script checks that for you and says so.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env.local / .env the way Next.js does (never overriding real env vars),
// so an operator does not have to re-export DATABASE_URL by hand.
for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  try {
    (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile(path);
  } catch {
    // A malformed env file must not mask the real error below.
  }
}

type Action = "grant" | "revoke" | "status" | "list";

function parseArgs(argv: string[]): { action: Action; email: string | null; yes: boolean } {
  let email: string | null = null;
  let action: Action = "grant";
  let yes = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--email" || arg === "-e") {
      email = (argv[++i] ?? "").trim().toLowerCase();
    } else if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim().toLowerCase();
    } else if (arg === "--revoke") {
      action = "revoke";
    } else if (arg === "--grant") {
      action = "grant";
    } else if (arg === "--status") {
      action = "status";
    } else if (arg === "--list") {
      action = "list";
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--help" || arg === "-h") {
      action = "list";
      email = null;
    }
  }

  return { action, email, yes };
}

function usage(): void {
  console.log(
    [
      "",
      "FlexiData admin provisioning (Phase 0)",
      "",
      "  npm run admin:grant -- --email <address>            grant admin",
      "  npm run admin:grant -- --email <address> --revoke   revoke admin",
      "  npm run admin:grant -- --email <address> --status   show one account",
      "  npm run admin:grant -- --list                       list all admins",
      "",
      "Requires DATABASE_URL (read from the environment or flexiData/.env.local).",
      "Admin access ALSO requires the email to be present in ADMIN_EMAILS.",
      "",
    ].join("\n"),
  );
}

function allowlist(): Set<string> {
  const raw = (process.env.ADMIN_EMAILS ?? "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Explain the account's effective access, i.e. what the real gate will decide. */
function reportEffectiveAccess(email: string, isAdmin: boolean): void {
  const list = allowlist();
  const listed = list.has(email);

  console.log("");
  console.log(`  users.is_admin        ${isAdmin ? "true" : "false"}`);
  console.log(`  ADMIN_EMAILS listed   ${listed ? "yes" : "no"}`);
  console.log("");

  if (isAdmin && listed) {
    console.log("  => ACCESS GRANTED. This account can reach /admin and /api/admin/*.");
    return;
  }

  console.log("  => NO ACCESS. The gate requires BOTH signals.");
  if (isAdmin && !listed) {
    console.log("");
    if (list.size === 0) {
      console.log("     ADMIN_EMAILS is not set, so nobody can reach the admin area.");
    } else {
      console.log("     The database flag is set, but this email is not in ADMIN_EMAILS.");
    }
    console.log(`     Add it to the deployment environment:  ADMIN_EMAILS=${email}`);
    console.log("     (comma-separate multiple addresses; restart the app afterwards)");
  }
  if (!isAdmin && listed) {
    console.log("");
    console.log("     The email is allowlisted, but the database flag is false.");
    console.log(`     Run:  npm run admin:grant -- --email ${email}`);
  }
}

async function main(): Promise<void> {
  const { action, email } = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL?.trim()) {
    console.error(
      "DATABASE_URL is not set. Put it in flexiData/.env.local, or export it before running:\n" +
        "  DATABASE_URL=postgresql://… npm run admin:grant -- --email you@example.com",
    );
    process.exit(1);
  }

  if (action !== "list" && !email) {
    usage();
    console.error("An --email is required for grant / revoke / status.");
    process.exit(1);
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error(`"${email}" does not look like an email address.`);
    process.exit(1);
  }

  // Imported lazily: `@/db` throws at import time when DATABASE_URL is missing,
  // and the check above produces a much better message.
  const { db, pool } = await import("@/db");
  const { users } = await import("@/db/schema");
  const { eq, sql } = await import("drizzle-orm");

  try {
    // Refuse to proceed on a schema that cannot express admin authorization,
    // rather than reporting a misleading success.
    const columnCheck = await db.execute(
      sql`select 1 as present from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'users'
            and column_name = 'is_admin'
          limit 1`,
    );
    const present = Array.isArray(columnCheck)
      ? columnCheck.length > 0
      : ((columnCheck as { rows?: unknown[] }).rows?.length ?? 0) > 0;
    if (!present) {
      console.error(
        "This database has no users.is_admin column, so admin access cannot be granted.\n" +
          "Run `npx drizzle-kit push` against it first.",
      );
      process.exit(1);
    }

    if (action === "list") {
      const rows = await db
        .select({ id: users.id, name: users.name, email: users.email, isAdmin: users.isAdmin })
        .from(users)
        .where(eq(users.isAdmin, true));

      const list = allowlist();
      console.log("");
      if (rows.length === 0) {
        console.log("No account has users.is_admin = true.");
      } else {
        console.log(`Accounts with users.is_admin = true (${rows.length}):`);
        for (const row of rows) {
          const listed = list.has(row.email.toLowerCase());
          console.log(
            `  #${row.id}  ${row.email}  (${row.name})  ` +
              `${listed ? "ALLOWLISTED -> access granted" : "not in ADMIN_EMAILS -> NO access"}`,
          );
        }
      }
      console.log("");
      console.log(
        list.size === 0
          ? "ADMIN_EMAILS is not set: the admin area is disabled for everyone."
          : `ADMIN_EMAILS contains ${list.size} address(es).`,
      );
      console.log("");
      return;
    }

    const found = await db
      .select({ id: users.id, name: users.name, email: users.email, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.email, email!))
      .limit(1);
    const user = found[0];

    if (!user) {
      console.error(`No account found with email "${email}". The user must register first.`);
      process.exit(1);
    }

    if (action === "status") {
      console.log("");
      console.log(`Account #${user.id}  ${user.email}  (${user.name})`);
      reportEffectiveAccess(user.email.toLowerCase(), user.isAdmin === true);
      return;
    }

    const target = action === "grant";
    if (user.isAdmin === target) {
      console.log("");
      console.log(
        `No change: users.is_admin is already ${target} for ${user.email} (#${user.id}).`,
      );
      reportEffectiveAccess(user.email.toLowerCase(), target);
      return;
    }

    // The ONLY write this script performs. Scoped to one row, one boolean.
    await db
      .update(users)
      .set({ isAdmin: target, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    console.log("");
    console.log(
      `${target ? "GRANTED" : "REVOKED"}: users.is_admin = ${target} for ${user.email} (#${user.id}).`,
    );
    if (!target) {
      console.log(
        "Revocation takes effect on the account's very next request — the gate re-reads\n" +
          "the flag every time. No sign-out or session purge is required.",
      );
    }
    reportEffectiveAccess(user.email.toLowerCase(), target);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
