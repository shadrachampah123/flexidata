import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit only auto-loads `.env` — it never reads `.env.local`, which is
 * the file this project (and Next.js) actually uses for secrets. That is why a
 * `drizzle-kit push` aimed at production could silently land on a laptop: with
 * the real `DATABASE_URL` invisible to drizzle-kit, the config fell back to a
 * hard-coded localhost URL and migrated the wrong database without failing.
 *
 * So load the env files ourselves, in the same precedence Next.js uses
 * (`.env.local` wins over `.env`), and never override a variable that was
 * already exported by the shell / CI / Vercel.
 */
function loadEnvFiles(): void {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    try {
      // Built in since Node 20.12; does not overwrite existing env vars.
      (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile(path);
    } catch {
      // A malformed env file should not mask the real error below.
    }
  }
}

const localUrl = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

/**
 * `drizzle-kit generate` diffs the schema locally and never opens a connection,
 * so it is the one command that must still work without a database. (No command
 * at all just prints the help text, which also needs no connection.)
 */
const command = process.argv.slice(2).find((arg) => !arg.startsWith("-")) ?? "";
const needsConnection = command !== "generate" && command !== "";

/** A local database is almost certainly a mistake on CI / Vercel. */
const onSharedEnvironment = Boolean(process.env.CI || process.env.VERCEL);
const allowLocalDatabase = ["1", "true", "yes", "on"].includes(
  (process.env.DRIZZLE_ALLOW_LOCAL_DB ?? "").trim().toLowerCase(),
);

function looksLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

loadEnvFiles();

const databaseUrl = process.env.DATABASE_URL?.trim() || "";
let url = databaseUrl;

if (!url && !needsConnection) {
  // Harmless placeholder: `generate` never dials the database.
  url = localUrl;
}

if (!databaseUrl) {
  if (needsConnection) {
    throw new Error(
      "DATABASE_URL is not set, so drizzle-kit has no database to migrate.\n" +
        "  • Put it in flexiData/.env.local (git-ignored) — that is the file the app reads.\n" +
        "  • Or export it before running: DATABASE_URL=postgresql://… npx drizzle-kit push\n" +
        "  • On Vercel, run it from your terminal against the Production connection string.\n" +
        `Refusing to guess and migrate "${localUrl}" instead — that is how a migration\n` +
        "silently failed to reach production.",
    );
  }
} else if (looksLocal(url) && onSharedEnvironment && !allowLocalDatabase) {
  throw new Error(
    `DATABASE_URL points at a local database (${url}) but this looks like CI or Vercel.\n` +
      "A migration here would apply to a throwaway server and production would stay\n" +
      "unchanged. Set the real DATABASE_URL for this environment, or set\n" +
      "DRIZZLE_ALLOW_LOCAL_DB=1 if a local database really is intended.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url,
  },
});
