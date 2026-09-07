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
    // Optimized for Vercel serverless + Neon: small warm pool, fast failure,
    // keep-alive to avoid TLS handshake on every request.
    max: 10,
    min: 0,
    connectionTimeoutMillis: 4000,
    idleTimeoutMillis: 20_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // Neon requires SSL; `pg` sets it from the connection string.
    // Fail fast on slow queries (prevents 3s hangs from queuing).
    statement_timeout: 8000,
    query_timeout: 8500,
    allowExitOnIdle: true,
  });

// Cache the pool across hot reloads and warm serverless invocations.
// Previously only cached in development — production reuse is equally critical
// on Vercel where the same container serves multiple requests.
globalForDb.__flexidataPgPool = pool;

export const db = drizzle(pool);
