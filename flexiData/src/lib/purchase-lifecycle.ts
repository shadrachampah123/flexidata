import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool } from "@/db";
import { creditReferralReward } from "@/lib/referrals";
import { POINTS_RATE } from "@/lib/constants";
import { assertReloadlySandboxConfiguration, lookupReloadlySandbox } from "@/lib/reloadly";
import {
  assertDataProviderRuntimeSafe, DataProviderFloatError, getDataProviderCode, submitDataBundleOrder,
  type DataBundleOrder, type GatewayResult,
} from "@/lib/data-gateway";

export type PurchaseState = "created" | "submitted" | "pending" | "unknown" | "delivered" | "failed";
export class PurchaseConflict extends Error {}
export class PurchaseFundsError extends Error {}

/** Hard ceiling on automatic status reads per attempt (also enforced by the
 * `poll_count` CHECK in migration 0011). Exhausted rows are never polled again. */
export const MAX_PURCHASE_POLLS = 12;
/** A nonterminal row not polled for this long, or a `created` row older than
 * this, is an operational alert: the scheduler is absent/late or a crash left
 * a debited order before submission. */
export const RECONCILE_ATTENTION_MINUTES = 15;
/** Report cap; backlog beyond this must be investigated with the database. */
export const RECONCILE_REPORT_LIMIT = 500;

/** Raised after a batch has been processed when one or more settlements could
 * not be committed. Rows keep their lease/poll state and are retried later. */
export class PurchaseReconcileError extends Error {
  constructor(readonly failed: number, readonly claimed: number) {
    super(`${failed} of ${claimed} claimed status settlements failed; affected rows remain unresolved.`);
    this.name = "PurchaseReconcileError";
  }
}

export type ReconcileSummary = {
  unresolved: number;
  byState: Record<string, number>;
  /** Provider-referenced rows that the poller may still read. */
  pollable: number;
  /** Pollable rows whose next read is more than RECONCILE_ATTENTION_MINUTES late. */
  overdue: number;
  /** Nonterminal rows that used all automatic reads; manual investigation only. */
  exhausted: number;
  /** submitted/unknown rows with no provider reference: never polled. */
  withoutProviderReference: number;
  /** `created` rows (debited, never submitted) older than the attention window. */
  staleCreated: number;
  oldestUnresolvedAt: string | null;
  /** True when the unresolved backlog exceeds the report cap. */
  truncated: boolean;
};

/** Operator-facing attention categories. Empty array means nothing needs action. */
export function reconcileAttention(summary: ReconcileSummary): string[] {
  const items: string[] = [];
  if (summary.overdue > 0) items.push("reconciliation_overdue");
  if (summary.exhausted > 0) items.push("retry_budget_exhausted");
  if (summary.withoutProviderReference > 0) items.push("unresolved_without_provider_reference");
  if (summary.staleCreated > 0) items.push("created_not_submitted");
  if (summary.truncated) items.push("backlog_exceeds_report_cap");
  return items;
}

/** Submission success is NOT delivery evidence. Only correlated status lookup
 * may produce a terminal result for a real provider. No generic status contract
 * has been verified, so generic purchases remain unknown for operator review. */
export function verifiedState(result: GatewayResult): PurchaseState {
  if (result.providerCode !== "reloadly") return "unknown";
  if (result.providerStatus === "delivered" && result.status === "successful") return "delivered";
  if (result.providerStatus === "rejected" && result.status === "failed") return "failed";
  return result.providerStatus === "accepted" ? "pending" : "unknown";
}

export class PurchaseLifecycle {
  constructor(private readonly database: Pool = pool) {}

  private async atomic<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  /** Wallet row lock serializes claim + debit; UNIQUE is a second DB guard.
   * The ledger, claim and debit all commit or all roll back. Missing migration
   * fails closed, never falls back to a non-durable purchase. */
  async create(order: DataBundleOrder, key: string, source: "wallet" | "checkout" = "wallet") {
    assertDataProviderRuntimeSafe();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(key)) throw new PurchaseConflict("Invalid Idempotency-Key");
    if (!Number.isFinite(order.amount) || order.amount <= 0 || Math.abs(Math.round(order.amount * 100) - order.amount * 100) > 0.000001) {
      throw new PurchaseConflict("Invalid purchase amount");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify([
      order.network, order.recipient, order.planLabel, order.category,
      order.providerProductCode, order.amount.toFixed(2), source,
    ])).digest("hex");
    return this.atomic(async client => {
      await client.query("SELECT id FROM wallets WHERE id=$1 FOR UPDATE", [order.walletId]);
      const prior = await client.query("SELECT * FROM purchase_attempts WHERE wallet_id=$1 AND request_key=$2", [order.walletId, key]);
      if (prior.rows[0]) {
        if (prior.rows[0].fingerprint !== fingerprint) throw new PurchaseConflict("Idempotency-Key reused for another purchase");
        return { ref: prior.rows[0].ref as string, created: false };
      }
      if (source === "checkout") {
        const paid = await client.query(`UPDATE checkout_orders SET order_status='fulfilling', fulfillment_status='submitted', updated_at=now()
          WHERE ref=$1 AND wallet_id=$2 AND payment_status='successful' AND order_status='paid' RETURNING ref`, [order.reference, order.walletId]);
        if (!paid.rowCount) throw new PurchaseConflict("Checkout is not ready for fulfillment");
      } else {
        const debit = await client.query("UPDATE wallets SET balance=balance-$2::numeric WHERE id=$1 AND balance >= $2::numeric RETURNING id", [order.walletId, order.amount.toFixed(2)]);
        if (!debit.rowCount) throw new PurchaseFundsError("insufficient_funds");
      }
      // Preserve the existing generic GHS float projection, but reserve it
      // atomically. Reloadly denomination/currency is unverified: do not infer
      // a provider spend from the customer retail price.
      let floatReserved = false;
      if (getDataProviderCode() !== "reloadly") {
        const snapshot = await client.query("SELECT * FROM provider_float_balances WHERE provider_code=$1 AND network=$2 FOR UPDATE", [getDataProviderCode(), order.network]);
        if (snapshot.rows[0]) {
          if (snapshot.rows[0].currency !== "GHS") throw new PurchaseConflict("Provider float currency requires review");
          const reserve = await client.query(`UPDATE provider_float_balances SET available_balance=available_balance-$3::numeric,
            reserved_balance=reserved_balance+$3::numeric,updated_at=now() WHERE provider_code=$1 AND network=$2
            AND available_balance >= $3::numeric RETURNING id`, [getDataProviderCode(), order.network, order.amount.toFixed(2)]);
          if (!reserve.rowCount) throw new DataProviderFloatError("Insufficient provider float", Number(snapshot.rows[0].available_balance));
          floatReserved = true;
        }
      }
      await client.query(`INSERT INTO transactions
        (ref,wallet_id,type,status,fulfillment_status,direction,title,subtitle,amount,network,recipient,provider,provider_product_code,charged_at)
        VALUES ($1,$2,'data','pending','queued','out',$3,$4,$5,$6,$7,$8,$9,now())`,
      [order.reference, order.walletId, `${order.network} ${order.planLabel} Data`,
        source === "checkout" ? "[durable] Paid via Paystack" : "[durable] Awaiting provider confirmation", order.amount.toFixed(2), order.network, order.recipient, getDataProviderCode(), order.providerProductCode]);
      await client.query(`INSERT INTO purchase_attempts (ref,wallet_id,request_key,fingerprint,source,provider,request,float_reserved)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [order.reference, order.walletId, key, fingerprint, source, getDataProviderCode(), JSON.stringify(order), floatReserved]);
      return { ref: order.reference, created: true };
    });
  }

  async submit(order: DataBundleOrder, send = submitDataBundleOrder) {
    assertDataProviderRuntimeSafe();
    // Commit submitted BEFORE network IO. A crash on either side of send is
    // deliberately ambiguous. Nobody, including this process, retries POST.
    const claim = await this.database.query(`UPDATE purchase_attempts SET state='submitted',updated_at=now()
      WHERE ref=$1 AND state='created' RETURNING request,provider`, [order.reference]);
    if (!claim.rowCount) return;
    try {
      if (claim.rows[0].provider !== getDataProviderCode()) throw new PurchaseConflict("Provider configuration changed");
      const result = await send(claim.rows[0].request as DataBundleOrder);
      await this.database.query(`UPDATE purchase_attempts SET provider_reference=$2,
        state=$3,updated_at=now() WHERE ref=$1 AND state='submitted'`,
      [order.reference, result.providerReference, result.providerReference ? "pending" : "unknown"]);
      await this.database.query(`UPDATE transactions SET fulfillment_status='processing',fulfillment_attempts=1,
        provider_reference=$2,provider_status='awaiting_confirmation' WHERE ref=$1 AND status='pending'`, [order.reference, result.providerReference]);
    } catch {
      await this.database.query("UPDATE purchase_attempts SET state='unknown',updated_at=now() WHERE ref=$1 AND state='submitted'", [order.reference]);
    }
  }

  /** Terminal winner and ledger/refund/points/checkout settlement share one
   * transaction. Source checkout NEVER credits wallet balance on rejection:
   * its externally-paid refund remains an explicit operator/payment task. */
  async settle(ref: string, providerReference: string, state: PurchaseState, leaseToken: string) {
    return this.atomic(async client => {
      const claimed = await client.query(`UPDATE purchase_attempts SET state=$3,lease_token=NULL,lease_until=NULL,
        updated_at=now(),next_poll_at=now() + (LEAST(3600,30 * power(2,poll_count)) * interval '1 second')
        WHERE ref=$1 AND provider_reference=$2 AND lease_token=$4
        AND state IN ('submitted','pending','unknown') RETURNING *`, [ref, providerReference, state, leaseToken]);
      const attempt = claimed.rows[0];
      if (!attempt) return false;
      if (state !== "delivered" && state !== "failed") return true;
      const ledger = await client.query("SELECT * FROM transactions WHERE ref=$1 FOR UPDATE", [ref]);
      const tx = ledger.rows[0];
      if (tx.status !== "pending") throw new PurchaseConflict("Ledger is already terminal");
      const points = state === "delivered" ? Math.max(1, Math.round(Number(tx.amount) * POINTS_RATE)) : 0;
      if (state === "failed" && attempt.source === "wallet") {
        await client.query("UPDATE wallets SET balance=balance+$2::numeric WHERE id=$1", [tx.wallet_id, tx.amount]);
      }
      if (attempt.float_reserved) {
        await client.query(`UPDATE provider_float_balances SET reserved_balance=reserved_balance-$3::numeric,
          available_balance=available_balance + CASE WHEN $4 THEN $3::numeric ELSE 0 END,
          updated_at=now(),last_reference=$5,last_status=$6 WHERE provider_code=$1 AND network=$2`,
        [attempt.provider, tx.network, tx.amount, state === "failed", ref, state]);
      }
      if (points) {
        const wallet = await client.query("UPDATE wallets SET points=points+$2 WHERE id=$1 RETURNING user_id", [tx.wallet_id, points]);
        if (wallet.rows[0].user_id) await creditReferralReward(wallet.rows[0].user_id, tx.wallet_id, client);
      }
      await client.query(`UPDATE transactions SET status=$2::tx_status,fulfillment_status=$3::fulfillment_status,points=$4,
        fulfilled_at=CASE WHEN $2::text='successful' THEN now() ELSE NULL END,
        refunded_at=CASE WHEN $5 THEN now() ELSE NULL END,last_provider_sync_at=now(),provider_status=$6
        WHERE ref=$1`, [ref, state === "delivered" ? "successful" : "failed", state === "delivered" ? "delivered" : "failed", points, state === "failed" && attempt.source === "wallet", state]);
      if (attempt.source === "checkout") await client.query(`UPDATE checkout_orders SET
        order_status=$2::checkout_order_status,fulfillment_status=$3::fulfillment_status,provider_reference=$4,
        fulfilled_at=CASE WHEN $2::text='fulfilled' THEN now() ELSE NULL END,
        failed_at=CASE WHEN $2::text='fulfillment_failed' THEN now() ELSE NULL END,updated_at=now()
        WHERE ref=$1`, [ref, state === "delivered" ? "fulfilled" : "fulfillment_failed", state === "delivered" ? "delivered" : "failed", providerReference]);
      return true;
    });
  }

  /** Bounded, leased, fenced status reads. NEVER submits a purchase.
   * Default lookup requires sandbox configuration; that is checked INSIDE the
   * claim transaction, so a misconfigured run rolls back its claim and consumes
   * no poll budget. Each row is isolated: one failed settlement does not stop
   * the batch, and failures are raised after the batch as PurchaseReconcileError. */
  async reconcile(limit = 20, lookup = lookupReloadlySandbox) {
    const token = randomUUID();
    const claimed = await this.atomic(async client => {
      const rows = await client.query(`WITH due AS (
        SELECT ref FROM purchase_attempts WHERE provider='reloadly' AND provider_reference IS NOT NULL
        AND state IN ('submitted','pending','unknown') AND poll_count<${MAX_PURCHASE_POLLS} AND next_poll_at<=now()
        AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_poll_at FOR UPDATE SKIP LOCKED LIMIT $1
      ) UPDATE purchase_attempts a SET lease_until=now()+interval '2 minutes',lease_token=$2,
        poll_count=poll_count+1 FROM due WHERE a.ref=due.ref RETURNING a.*`, [Math.max(1, Math.min(100, limit)), token]);
      if (rows.rowCount && lookup === lookupReloadlySandbox) assertReloadlySandboxConfiguration();
      return rows.rows;
    });
    let failed = 0;
    for (const attempt of claimed) {
      let state: PurchaseState = "unknown";
      try {
        const result = await lookup(attempt.ref, attempt.provider_reference);
        if (result.providerReference === attempt.provider_reference) state = verifiedState(result);
      } catch { /* conservative unknown, bounded next read */ }
      try {
        await this.settle(attempt.ref, attempt.provider_reference, state, token);
      } catch {
        // Logged by the CLI as a count only: no ref, provider data or messages.
        failed += 1;
      }
    }
    if (failed > 0) throw new PurchaseReconcileError(failed, claimed.length);
    return claimed.length;
  }

  /** Read-only aggregate used by monitoring. Counts only; no provider data. */
  async reportSummary(): Promise<ReconcileSummary> {
    const agg = (await this.database.query(`SELECT
        count(*)::int AS unresolved,
        count(*) FILTER (WHERE state IN ('submitted','pending','unknown') AND provider_reference IS NOT NULL
          AND poll_count<${MAX_PURCHASE_POLLS} AND next_poll_at<now() - interval '${RECONCILE_ATTENTION_MINUTES} minutes')::int AS overdue,
        count(*) FILTER (WHERE state IN ('submitted','pending','unknown') AND provider_reference IS NOT NULL
          AND poll_count<${MAX_PURCHASE_POLLS})::int AS pollable,
        count(*) FILTER (WHERE state IN ('submitted','pending','unknown') AND poll_count>=${MAX_PURCHASE_POLLS})::int AS exhausted,
        count(*) FILTER (WHERE state IN ('submitted','unknown') AND provider_reference IS NULL)::int AS without_reference,
        count(*) FILTER (WHERE state='created' AND updated_at < now() - interval '${RECONCILE_ATTENTION_MINUTES} minutes')::int AS stale_created,
        min(updated_at) AS oldest
      FROM purchase_attempts WHERE state NOT IN ('delivered','failed')`)).rows[0];
    const states = (await this.database.query(`SELECT state, count(*)::int AS n FROM purchase_attempts
      WHERE state NOT IN ('delivered','failed') GROUP BY state ORDER BY state`)).rows;
    return {
      unresolved: agg.unresolved,
      byState: Object.fromEntries(states.map(r => [r.state as string, r.n as number])),
      pollable: agg.pollable,
      overdue: agg.overdue,
      exhausted: agg.exhausted,
      withoutProviderReference: agg.without_reference,
      staleCreated: agg.stale_created,
      oldestUnresolvedAt: agg.oldest ? new Date(agg.oldest).toISOString() : null,
      truncated: agg.unresolved > RECONCILE_REPORT_LIMIT,
    };
  }

  async summary(ref: string) {
    const row = (await this.database.query(`SELECT t.status,t.fulfillment_status,t.title,t.points AS points_earned,
      w.balance,w.points FROM transactions t JOIN wallets w ON w.id=t.wallet_id WHERE t.ref=$1`, [ref])).rows[0];
    return { status: row.status, fulfillmentStatus: row.fulfillment_status, title: row.title,
      pointsEarned: row.points_earned, balance: Number(row.balance), points: row.points };
  }

  async report() {
    return (await this.database.query(`SELECT ref,source,provider,state,provider_reference,poll_count,updated_at
      FROM purchase_attempts WHERE state NOT IN ('delivered','failed') ORDER BY updated_at LIMIT ${RECONCILE_REPORT_LIMIT}`)).rows;
  }
}
