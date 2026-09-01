import { defineConfig } from "drizzle-kit";

// Reads the same DATABASE_URL the app uses at runtime (see src/db/index.ts),
// so drizzle-kit migrations target the right environment. In production /
// preview that is Vercel's DATABASE_URL; locally it falls back to the dev DB
// so `drizzle-kit generate/push` works without extra setup.
const databaseUrl = process.env.DATABASE_URL;
const localUrl = "postgresql://postgres:postgres@127.0.0.1:5432/app_db";

if (!databaseUrl) {
  console.warn(
    "DATABASE_URL is not set; falling back to the local dev database " +
      `(${localUrl}). Set DATABASE_URL to run migrations against another environment.`,
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url: databaseUrl ?? localUrl,
  },
});
