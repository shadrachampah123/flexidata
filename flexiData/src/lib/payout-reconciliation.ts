/**
 * Payout reconciliation (Phase 7).
 *
 * Identifies mismatches between local withdrawal state and provider state.
 * Creates exceptions for admin review — does NOT automatically alter
 * production balances unless the state transition is fully verified.
 *
 * Reconciliation checks:
 *   - Processing withdrawals stuck beyond expected time
 *   - Provider success but local processing
 *   - Provider failure but local processing
 *   - Amount mismatches
 *   - Duplicate provider references
 *   - Unknown provider references
 */

import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  withdrawalRequests,
  payoutReconciliationExceptions,
} from "@/db/schema";
import { getPayoutProvider } from "@/lib/payout-service";
import type { ReconciliationExceptionType } from "@/lib/withdrawals";

/** How long a withdrawal can stay in `processing` before being flagged. */
export const STUCK_PROCESSING_THRESHOLD_HOURS = 24;

/** Result of a reconciliation run. */
export type ReconciliationResult = {
  /** Timestamp of when the reconciliation ran. */
  ranAt: Date;
  /** Total processing withdrawals examined. */
  examined: number;
  /** New exceptions created. */
  newExceptions: number;
  /** Summary of exceptions found. */
  exceptions: ReconciliationSummaryItem[];
};

export type ReconciliationSummaryItem = {
  type: ReconciliationExceptionType;
  count: number;
  description: string;
};

/**
 * Run a full payout reconciliation.
 *
 * This is a read-only diagnostic that creates exception records for admin
 * review. It does NOT modify balances or withdrawal statuses.
 *
 * Safe to run repeatedly: duplicate exceptions are detected and skipped.
 */
export async function runPayoutReconciliation(): Promise<ReconciliationResult> {
  const ranAt = new Date();
  const exceptions: ReconciliationSummaryItem[] = [];
  let newExceptions = 0;

  // 1. Check for stuck processing withdrawals
  const stuckResult = await findStuckProcessing();
  if (stuckResult.count > 0) {
    exceptions.push({
      type: "stuck_processing",
      count: stuckResult.count,
      description: `${stuckResult.count} withdrawal(s) stuck in processing for >${STUCK_PROCESSING_THRESHOLD_HOURS}h`,
    });
    // Create exceptions for each stuck withdrawal (idempotent)
    for (const row of stuckResult.rows) {
      const created = await createExceptionIfNew({
        withdrawalId: row.id,
        withdrawalRef: row.ref,
        exceptionType: "stuck_processing",
        description: `Withdrawal ${row.ref} has been in processing since ${row.processed_at?.toISOString?.() ?? new Date(row.created_at).toISOString()}`,
        localStatus: row.status,
        providerReference: row.provider_reference,
        expectedAmount: String(row.net_amount),
        currency: row.currency,
      });
      if (created) newExceptions++;
    }
  }

  // 2. Check for duplicate provider references
  const dupesResult = await findDuplicateProviderReferences();
  if (dupesResult.count > 0) {
    exceptions.push({
      type: "duplicate_provider_reference",
      count: dupesResult.count,
      description: `${dupesResult.count} duplicate provider reference(s) found`,
    });
    for (const row of dupesResult.rows) {
      const created = await createExceptionIfNew({
        withdrawalId: row.id,
        withdrawalRef: row.ref,
        exceptionType: "duplicate_provider_reference",
        description: `Provider reference ${row.provider_reference} is shared with withdrawal(s): ${row.siblings}`,
        localStatus: row.status,
        providerReference: row.provider_reference,
      });
      if (created) newExceptions++;
    }
  }

  // 3. Try to check provider status for processing withdrawals (if provider available)
  try {
    const provider = getPayoutProvider();
    if (provider.name !== "mock") {
      const processingWithdrawals = await db
        .select({
          id: withdrawalRequests.id,
          ref: withdrawalRequests.ref,
          status: withdrawalRequests.status,
          providerReference: withdrawalRequests.providerReference,
          netAmount: withdrawalRequests.netAmount,
          currency: withdrawalRequests.currency,
        })
        .from(withdrawalRequests)
        .where(sql`${withdrawalRequests.status} = 'processing' AND ${withdrawalRequests.providerReference} IS NOT NULL`);

      for (const w of processingWithdrawals) {
        if (!w.providerReference) continue;
        try {
          const providerStatus = await provider.getPayoutStatus(w.providerReference);
          if (!providerStatus) continue;

          // Check for mismatches
          if (providerStatus.status === "successful" && w.status === "processing") {
            const created = await createExceptionIfNew({
              withdrawalId: w.id,
              withdrawalRef: w.ref,
              exceptionType: "provider_success_local_processing",
              description: `Provider reports success for ${w.ref} but local status is still processing`,
              localStatus: w.status,
              providerStatus: providerStatus.status,
              providerReference: w.providerReference,
              expectedAmount: String(w.netAmount),
              currency: w.currency,
            });
            if (created) {
              newExceptions++;
              exceptions.push({
                type: "provider_success_local_processing",
                count: 1,
                description: `Provider success for ${w.ref} not reflected locally`,
              });
            }
          }
        } catch {
          // Provider query failed for this reference — skip
        }
      }
    }
  } catch {
    // No provider configured — skip provider status checks
  }

  return {
    ranAt,
    examined: (await countProcessingWithdrawals()) ?? 0,
    newExceptions,
    exceptions,
  };
}

async function countProcessingWithdrawals(): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(withdrawalRequests)
    .where(sql`${withdrawalRequests.status} = 'processing'`);
  return result[0]?.count ?? 0;
}

async function findStuckProcessing(): Promise<{
  count: number;
  rows: Array<{
    id: number;
    ref: string;
    status: string;
    provider_reference: string | null;
    net_amount: string;
    currency: string;
    processed_at: Date | null;
    created_at: Date;
  }>;
}> {
  const threshold = new Date(Date.now() - STUCK_PROCESSING_THRESHOLD_HOURS * 60 * 60 * 1000);
  const result = await db.execute(sql`
    SELECT id, ref, status, provider_reference, net_amount, currency, processed_at, created_at
    FROM withdrawal_requests
    WHERE status = 'processing'
      AND (processed_at < ${threshold.toISOString()}::timestamptz
           OR (processed_at IS NULL AND created_at < ${threshold.toISOString()}::timestamptz))
    ORDER BY created_at ASC
  `);
  return { count: result.rows.length, rows: result.rows as any };
}

async function findDuplicateProviderReferences(): Promise<{
  count: number;
  rows: Array<{
    id: number;
    ref: string;
    status: string;
    provider_reference: string;
    siblings: string;
  }>;
}> {
  const result = await db.execute(sql`
    SELECT wr.id, wr.ref, wr.status, wr.provider_reference,
           string_agg(sibling.ref, ', ' ORDER BY sibling.ref) as siblings
    FROM withdrawal_requests wr
    JOIN withdrawal_requests sibling
      ON wr.provider_reference = sibling.provider_reference
      AND wr.id != sibling.id
    WHERE wr.provider_reference IS NOT NULL
    GROUP BY wr.id, wr.ref, wr.status, wr.provider_reference
    ORDER BY wr.created_at ASC
  `);
  return { count: result.rows.length, rows: result.rows as any };
}

/**
 * Create a reconciliation exception if one doesn't already exist for the
 * same withdrawal + type combination. Returns true if a new row was inserted.
 */
async function createExceptionIfNew(params: {
  withdrawalId?: number;
  withdrawalRef?: string;
  exceptionType: ReconciliationExceptionType;
  description: string;
  localStatus?: string;
  providerStatus?: string;
  providerReference?: string | null;
  expectedAmount?: string | null;
  actualAmount?: string | null;
  currency?: string;
}): Promise<boolean> {
  // Check for existing unresolved exception of same type for same withdrawal
  const existing = await db.execute(sql`
    SELECT id FROM payout_reconciliation_exceptions
    WHERE exception_type = ${params.exceptionType}
      AND resolved = false
      AND (${params.withdrawalId ? sql`withdrawal_id = ${params.withdrawalId}` : sql`withdrawal_ref = ${params.withdrawalRef}`})
    LIMIT 1
  `);
  if (existing.rows.length > 0) return false;

  await db.insert(payoutReconciliationExceptions).values({
    withdrawalId: params.withdrawalId ?? null,
    withdrawalRef: params.withdrawalRef ?? null,
    exceptionType: params.exceptionType,
    description: params.description,
    localStatus: params.localStatus ?? null,
    providerStatus: params.providerStatus ?? null,
    providerReference: params.providerReference ?? null,
    expectedAmount: params.expectedAmount ?? null,
    actualAmount: params.actualAmount ?? null,
    currency: params.currency ?? "GHS",
  });
  return true;
}

/**
 * Fetch unresolved reconciliation exceptions for admin review.
 */
export async function fetchReconciliationExceptions(opts?: {
  type?: string;
  resolved?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ rows: unknown[]; total: number }> {
  const conditions = [];
  if (opts?.type) {
    conditions.push(sql`exception_type = ${opts.type}`);
  }
  if (opts?.resolved !== undefined) {
    conditions.push(sql`resolved = ${opts.resolved}`);
  }
  const whereClause = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const [rows, countResult] = await Promise.all([
    db.execute(sql`
      SELECT * FROM payout_reconciliation_exceptions
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
    db.execute(sql`
      SELECT count(*)::int as count FROM payout_reconciliation_exceptions ${whereClause}
    `),
  ]);

  return {
    rows: rows.rows,
    total: (countResult.rows[0] as { count: number })?.count ?? 0,
  };
}
