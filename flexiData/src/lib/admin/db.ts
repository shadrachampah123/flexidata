import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "@/db";

/**
 * Phase 1 admin execution layer — STRUCTURALLY READ-ONLY.
 *
 * Every query the Admin & Operations Dashboard runs goes through
 * {@link withReadOnlyTx}. Two independent mechanisms make a write impossible:
 *
 *  1. **The database.** The transaction is opened with `access mode read only`
 *     *and* `SET TRANSACTION READ ONLY` is issued as its first statement.
 *     PostgreSQL then rejects any INSERT / UPDATE / DELETE / DDL / sequence
 *     advance with SQLSTATE `25006` (`read_only_sql_transaction`). This is the
 *     authoritative guarantee: even a bug in a query below cannot change a
 *     balance, a payment record or a delivery row.
 *
 *  2. **This module.** Every statement handed to the executor is inspected
 *     before it is sent, and anything that is not a read (or transaction
 *     control) is refused in application code with a loud error. That turns a
 *     would-be write into a visible failure during development instead of a
 *     database error at runtime.
 *
 * There is deliberately no helper here that accepts a caller-supplied SQL
 * string: every statement in `src/lib/admin/queries.ts` is a server-side
 * constant with all user input bound as parameters.
 */

/** The narrow slice of a database transaction the admin read layer is given. */
export type AdminExecutor = {
  execute: <T extends Record<string, unknown> = Record<string, unknown>>(
    query: SQL,
  ) => Promise<{ rows: T[] }>;
};

const dialect = new PgDialect();

/** Render a drizzle `sql` fragment to its SQL text (for the guard below). */
export function statementText(query: SQL): string {
  return dialect.sqlToQuery(query).sql;
}

/**
 * Statements that are allowed inside an admin read transaction: reads, CTEs and
 * the transaction-control verbs the wrapper itself uses.
 */
const READ_PREFIX = /^(select|with|table|values)\b/i;
const TX_CONTROL_PREFIX =
  /^(begin|start\s+transaction|commit|rollback|savepoint|release|set|show|discard|deallocate|close|fetch|listen|unlisten)\b/i;

/**
 * Anything that mutates data or structure. `into` is listed because
 * `SELECT … INTO` creates a table, and `nextval`/`setval` because advancing a
 * sequence is a write even though it looks like a function call.
 */
const WRITE_KEYWORDS =
  /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|call|do|copy|refresh|reindex|vacuum|cluster|lock|merge|into|nextval|setval|pg_advisory)\b/i;

/** Raised when admin code attempts something that is not a read. */
export class AdminReadOnlyViolation extends Error {
  constructor(statement: string) {
    super(
      `[flexidata:admin] refusing a non read-only statement inside an admin read transaction: ${statement.slice(0, 160)}`,
    );
    this.name = "AdminReadOnlyViolation";
  }
}

/**
 * Guard used by {@link withReadOnlyTx}. Exported so the verification harness can
 * assert the behaviour directly without a database.
 */
export function assertReadOnlyStatement(text: string): void {
  const stripped = text
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;+$/, "");

  if (TX_CONTROL_PREFIX.test(stripped)) return;
  if (!READ_PREFIX.test(stripped)) throw new AdminReadOnlyViolation(stripped);
  if (WRITE_KEYWORDS.test(stripped)) throw new AdminReadOnlyViolation(stripped);
}

type RawTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run `fn` inside a database transaction the server itself refuses to write in.
 *
 * @param label  short, human label used in logs (`admin.wallets`, …).
 * @param fn     receives an {@link AdminExecutor} — the ONLY way the admin read
 *               layer talks to PostgreSQL in Phase 1.
 */
export async function withReadOnlyTx<T>(
  label: string,
  fn: (tx: AdminExecutor) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(
      async (rawTx: RawTx) => {
        const executor: AdminExecutor = {
          execute: <R extends Record<string, unknown> = Record<string, unknown>>(query: SQL) => {
            assertReadOnlyStatement(statementText(query));
            return rawTx.execute(query) as unknown as Promise<{ rows: R[] }>;
          },
        };

        // `begin read only` (the accessMode below) and this statement say the
        // same thing; both are kept so the guarantee survives a change in how
        // the driver spells the transaction preamble.
        await executor.execute(sql`set transaction read only`);

        return fn(executor);
      },
      { accessMode: "read only" },
    );
  } catch (error) {
    if (error instanceof AdminReadOnlyViolation) {
      console.error(`[flexidata:admin] read-only guard tripped during ${label}`, error.message);
    }
    throw error;
  }
}

/** Normalise a query result row count/aggregate that Postgres returns as text. */
export function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `count(*)` selector that always comes back as a JS number. */
export function countRows(result: { rows: Record<string, unknown>[] }): number {
  const row = result.rows[0];
  if (!row) return 0;
  const value = row.c ?? row.count ?? Object.values(row)[0];
  return num(value, 0);
}

/** Postgres `timestamptz` (Date or string) to an ISO string, or null. */
export function iso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Postgres `numeric` comes back as a decimal string; money needs 2dp. */
export function money2(value: unknown): number {
  return Math.round(num(value, 0) * 100) / 100;
}
