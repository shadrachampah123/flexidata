import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is missing. Add it as an Environment Variable in Vercel " +
      "(Settings → Environment Variables → Production/Preview/Development), " +
      "or set it in your local .env.local file.",
  );
}

const globalForDb = globalThis as typeof globalThis & {
  __flexidataPgPool?: Pool;
};

export const pool =
  globalForDb.__flexidataPgPool ??
  new Pool({
    connectionString: databaseUrl,
    // Keep the pool small and give up quickly on serverless so a dead DB
    // fails fast with a readable error instead of hanging the request.
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

// Cache the pool across hot reloads in development (and warm invocations).
if (process.env.NODE_ENV !== "production") {
  globalForDb.__flexidataPgPool = pool;
}

export const db = drizzle(pool);
