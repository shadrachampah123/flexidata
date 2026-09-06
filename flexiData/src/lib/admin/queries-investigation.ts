import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { hasTableColumns, withSchemaFallback } from "@/lib/schema-compat";
import { countRows, iso, money2, withReadOnlyTx, type AdminExecutor } from "@/lib/admin/db";
import { clampText, maskEmail, maskPhone } from "@/lib/admin/redact";
import {
  likePattern,
  offsetFor,
  parseDateFrom,
  parseDateTo,
  parseEnum,
  parseId,
  parsePageSize,
  parseSearch,
  type AdminList,
} from "@/lib/admin/filters";
import { isPaystackConfigured, paystackMode } from "@/lib/paystack";
import { buildTrackingInfo } from "@/lib/fulfillment";
import {
  calculatedBalanceSql,
  classifyReconciliation,
  reconciliationRule,
} from "@/lib/admin/reconciliation";
import { toAdminCaps, toTransactionRow, txColumnsSql, type AdminCaps } from "@/lib/admin/queries";
import { hasSupportSchema } from "@/lib/admin/queries-operations";
import {
  diagnoseCheckoutOrder,
  diagnoseDeposit,
  isOrderSupportActionable,
  mirrorFactsFrom,
  orderToTrackable,
  summarizeFindings,
  type DepositFacts,
  type OrderFacts,
  type WalletCreditFacts,
} from "@/lib/admin/diagnosis";
import type {
  AccountStatusView,
  AdminAuditResult,
  AdminAuditRow,
  AdminDepositInvestigation,
  AdminDepositRecord,
  AdminOrderInvestigation,
  AdminOrderRecord,
  AdminRecordedAction,
  AdminRefundReviewResult,
  AdminRefundReviewRow,
  AdminTransactionRow,
} from "@/lib/admin/types";

/**
 * Phase 2, Step 3 — the investigation read layer.
 *
 * Four reads, and that is the whole surface:
 *
 *  1. `loadOrderInvestigation(ref)`    one Paystack checkout order in full,
 *                                      with its ledger mirror, delivery
 *                                      timeline, audit trail and findings.
 *  2. `loadDepositDetail(ref)`         one wallet funding attempt, with the
 *                                      ledger credit rows, the owning wallet's
 *                                      reconciliation verdict and findings.
 *  3. `loadAdminAudit(query)`          the `admin_audit_logs` trail itself —
 *                                      every action any administrator has
 *                                      recorded, filterable and paginated.
 *  4. `loadRefundReviews(query)`       the refund-review backlog derived from
 *                                      that trail (Step 2 records reviews; this
 *                                      is the first place they can be worked).
 *
 * Guarantees, identical to the Phase 1/2 read layer:
 *
 *  - **Structurally read-only.** Every statement runs inside `withReadOnlyTx`,
 *    which opens the transaction `access mode read only` AND issues
 *    `SET TRANSACTION READ ONLY`, and additionally refuses any non-read
 *    statement in application code. There is no write API in this file — no
 *    `db.update`, no `insert`, no mutating SQL — so a bug here cannot change a
 *    balance, an order, a deposit or the audit trail.
 *  - **No settlement path is reachable.** This module imports nothing from
 *    `@/lib/deposits`, `@/lib/checkout`, `@/lib/data-gateway` or
 *    `@/lib/payments`. The only Paystack import is `paystackMode()` /
 *    `isPaystackConfigured()` — environment readers that report the posture and
 *    never touch the network or a key.
 *  - **Bound parameters only.** Every user-supplied value goes through the
 *    existing parsers (`parseSearch`, `parseId`, `parseEnum`, `parseDateFrom`)
 *    and is bound; no statement is assembled from caller text.
 *  - **Schema-drift aware.** The audit trail (0002) and its `target_ref`
 *    column (0003) are probed with the existing capability layer, so a lagging
 *    database degrades to "not available" instead of throwing.
 *  - **Minimum PII.** List views mask; the deliberately-opened single record
 *    does not (the established convention). Raw `provider_payload` /
 *    `provider_response` jsonb is never selected anywhere in this file.
 */

// ---------------------------------------------------------------------------
// Capability probes and constants
// ---------------------------------------------------------------------------

/** Columns `admin_audit_logs` must have for the trail to be readable at all. */
const AUDIT_COLUMNS = [
  "id",
  "admin_user_id",
  "target_user_id",
  "action",
  "reason",
  "created_at",
] as const;

/** Every action value the CHECK constraint currently permits (0002 + 0003). */
export const AUDIT_ACTIONS = [
  "suspend",
  "activate",
  "delivery_resolved",
  "refund_review",
] as const;

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  suspend: "Customer suspended",
  activate: "Customer activated",
  delivery_resolved: "Delivery confirmed by admin",
  refund_review: "Refund review recorded",
};

/** How much history one investigation page shows. A trail, not an export. */
const RECORDED_ACTION_LIMIT = 50;
/** Ledger rows shown for one deposit reference. */
const CREDIT_ROW_LIMIT = 20;

function auditReadable(rawCaps: Parameters<typeof hasTableColumns>[0]): boolean {
  return hasTableColumns(rawCaps, "admin_audit_logs", AUDIT_COLUMNS);
}

/**
 * Can the Paystack status probe run on this deployment at all? This reads the
 * ENVIRONMENT only — no network call, no key material, no database. A live key
 * without `PAYSTACK_LIVE_MODE` is reported as available here and refused by the
 * existing lock inside `@/lib/paystack` when the probe actually runs, which is
 * the correct place for that decision.
 */
export function probeAvailability(): {
  available: boolean;
  mode: "test" | "live" | "unconfigured";
  reason: string | null;
} {
  const mode = paystackMode();
  if (mode === "unconfigured" || !isPaystackConfigured()) {
    return {
      available: false,
      mode: "unconfigured",
      reason: "Paystack is not configured on this server, so there is nothing to ask it.",
    };
  }
  return { available: true, mode, reason: null };
}

// ---------------------------------------------------------------------------
// Statement helpers (same shape as the rest of the admin read layer)
// ---------------------------------------------------------------------------

async function all<T extends Record<string, unknown>>(tx: AdminExecutor, query: SQL): Promise<T[]> {
  const result = await tx.execute<T>(query);
  return result.rows ?? [];
}

async function firstRow<T extends Record<string, unknown>>(
  tx: AdminExecutor,
  query: SQL,
): Promise<T | null> {
  return (await all<T>(tx, query))[0] ?? null;
}

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function intOr(value: unknown, fallback: number | null = null): number | null {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function accountStatusOf(value: unknown): AccountStatusView {
  return value === "active" || value === "suspended" ? value : null;
}

function toMs(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// 1. Order investigation
// ---------------------------------------------------------------------------

/**
 * The `target_ref` projection.
 *
 * `admin_audit_logs` exists from migration 0002 but only carries `target_ref`
 * from 0003, and this file must stay readable on a database sitting BETWEEN the
 * two. The suspend/activate history below is useful either way, so the column
 * is selected only when the capability probe found it — the same convention
 * `ADMIN_AUDIT_REF_COLUMNS` establishes in `queries.ts`. Without it the account
 * history would have thrown on exactly the degraded database it is supposed to
 * survive (the Step 3 harness drops the column to prove the fix).
 */
function auditRefColumn(refTrail: boolean): SQL {
  return refTrail ? sql`"a"."target_ref" as "targetRef"` : sql`null::text as "targetRef"`;
}

/** Every admin action recorded against one order reference, newest first. */
async function loadRecordedActionsByRef(
  tx: AdminExecutor,
  ref: string,
): Promise<AdminRecordedAction[]> {
  const rows = await all<Record<string, unknown>>(
    tx,
    sql`select "a"."id" as "id", "a"."action" as "action", "a"."reason" as "reason",
               ${auditRefColumn(true)}, "a"."created_at" as "createdAt",
               "a"."admin_user_id" as "adminUserId", "adm"."name" as "adminName"
        from "admin_audit_logs" "a"
        left join "users" "adm" on "adm"."id" = "a"."admin_user_id"
        where "a"."target_ref" = ${ref}
        order by "a"."created_at" desc, "a"."id" desc
        limit ${RECORDED_ACTION_LIMIT}`,
  );
  return rows.map(mapRecordedAction);
}

/** Suspend / activate history for one customer, newest first. */
async function loadAccountActions(
  tx: AdminExecutor,
  userId: number | null,
  refTrail: boolean,
): Promise<AdminRecordedAction[]> {
  if (userId === null) return [];
  const rows = await all<Record<string, unknown>>(
    tx,
    sql`select "a"."id" as "id", "a"."action" as "action", "a"."reason" as "reason",
               ${auditRefColumn(refTrail)}, "a"."created_at" as "createdAt",
               "a"."admin_user_id" as "adminUserId", "adm"."name" as "adminName"
        from "admin_audit_logs" "a"
        left join "users" "adm" on "adm"."id" = "a"."admin_user_id"
        where "a"."target_user_id" = ${userId}
          and "a"."action" in ('suspend', 'activate')
        order by "a"."created_at" desc, "a"."id" desc
        limit ${RECORDED_ACTION_LIMIT}`,
  );
  return rows.map(mapRecordedAction);
}

function mapRecordedAction(row: Record<string, unknown>): AdminRecordedAction {
  return {
    id: Number(row.id),
    action: String(row.action ?? ""),
    adminUserId: Number(row.adminUserId),
    adminName: clampText(row.adminName ? String(row.adminName) : null, 120),
    reason: clampText(row.reason ? String(row.reason) : null, 240),
    targetRef: text(row.targetRef),
    createdAt: iso(row.createdAt) ?? "",
  };
}

function mapOrderRecord(
  row: Record<string, unknown>,
  now: number,
): AdminOrderRecord {
  const paymentStatus = String(row.paymentStatus ?? "");
  const orderStatus = String(row.orderStatus ?? "");
  const updatedAt = iso(row.updatedAt);
  const amount = money2(row.amount);
  return {
    id: Number(row.id),
    ref: String(row.ref ?? ""),
    userId: intOr(row.userId),
    walletId: intOr(row.walletId),
    customerName: text(row.userName),
    // Single-record view: the operator deliberately opened this order.
    customerEmail: text(row.userEmail) ?? text(row.customerEmail) ?? "—",
    customerPhone: text(row.userPhone) ?? text(row.customerPhone) ?? "—",
    accountStatus: accountStatusOf(row.userStatus),
    walletNumber: text(row.walletNumber),
    network: text(row.network),
    category: text(row.category),
    planLabel: text(row.planLabel),
    providerProductCode: text(row.providerProductCode),
    recipient: text(row.recipient) ?? "—",
    amount,
    amountSubunits: intOr(row.amountSubunits),
    currency: text(row.currency) ?? "GHS",
    paymentStatus,
    orderStatus,
    fulfillmentStatus: text(row.fulfillmentStatus),
    paystackTransactionId: text(row.paystackTransactionId),
    paystackChannel: text(row.paystackChannel),
    paystackGatewayResponse: clampText(
      row.paystackGatewayResponse ? String(row.paystackGatewayResponse) : null,
      240,
    ),
    providerReference: text(row.providerReference),
    providerStatus: clampText(row.providerStatus ? String(row.providerStatus) : null, 80),
    providerMessage: clampText(row.providerMessage ? String(row.providerMessage) : null, 240),
    paidAt: iso(row.paidAt),
    verifiedAt: iso(row.verifiedAt),
    fulfilledAt: iso(row.fulfilledAt),
    failedAt: iso(row.failedAt),
    abandonedAt: iso(row.abandonedAt),
    createdAt: iso(row.createdAt) ?? "",
    updatedAt,
    supportActionable: isOrderSupportActionable({
      paymentStatus,
      orderStatus,
      updatedAtMs: toMs(updatedAt),
      now,
    }),
  };
}

function orderFactsOf(order: AdminOrderRecord): OrderFacts {
  return {
    ref: order.ref,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    amount: order.amount,
    amountSubunits: order.amountSubunits,
    currency: order.currency,
    network: order.network,
    planLabel: order.planLabel,
    recipient: order.recipient,
    paystackTransactionId: order.paystackTransactionId,
    paystackGatewayResponse: order.paystackGatewayResponse,
    providerReference: order.providerReference,
    providerStatus: order.providerStatus,
    providerMessage: order.providerMessage,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    paidAt: order.paidAt,
    verifiedAt: order.verifiedAt,
    fulfilledAt: order.fulfilledAt,
    failedAt: order.failedAt,
    abandonedAt: order.abandonedAt,
  };
}

/**
 * One checkout order in full: the stored facts, the ledger mirror (when the
 * checkout flow wrote one), the delivery timeline from the existing pure
 * tracker, the audit trail for this reference and the diagnosis.
 *
 * Returns `null` when the reference is not a checkout order — including when it
 * is a wallet ledger reference or a deposit reference, which have their own
 * investigation views.
 */
export async function loadOrderInvestigation(
  ref: string,
): Promise<AdminOrderInvestigation | null> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    if (!caps.checkoutTable) return null;

    const hasUserStatus = hasTableColumns(rawCaps, "users", ["status"]);
    const audit = auditReadable(rawCaps);
    const refTrail = audit && hasSupportSchema(rawCaps);
    const now = Date.now();

    return withReadOnlyTx("admin.order-investigation", async (tx) => {
      const orderRow = await firstRow(
        tx,
        sql`select
              "o"."id" as "id", "o"."ref" as "ref", "o"."user_id" as "userId",
              "o"."wallet_id" as "walletId",
              "o"."customer_email" as "customerEmail", "o"."customer_phone" as "customerPhone",
              "o"."network" as "network", "o"."category" as "category",
              "o"."plan_label" as "planLabel", "o"."provider_product_code" as "providerProductCode",
              "o"."recipient" as "recipient",
              "o"."amount"::text as "amount", "o"."amount_subunits" as "amountSubunits",
              "o"."currency" as "currency",
              "o"."payment_status" as "paymentStatus", "o"."order_status" as "orderStatus",
              "o"."fulfillment_status" as "fulfillmentStatus",
              "o"."paystack_transaction_id" as "paystackTransactionId",
              "o"."paystack_channel" as "paystackChannel",
              "o"."paystack_gateway_response" as "paystackGatewayResponse",
              "o"."provider_reference" as "providerReference",
              "o"."provider_status" as "providerStatus",
              "o"."provider_message" as "providerMessage",
              "o"."paid_at" as "paidAt", "o"."verified_at" as "verifiedAt",
              "o"."fulfilled_at" as "fulfilledAt", "o"."failed_at" as "failedAt",
              "o"."abandoned_at" as "abandonedAt",
              "o"."created_at" as "createdAt", "o"."updated_at" as "updatedAt",
              "u"."name" as "userName", "u"."email" as "userEmail", "u"."phone" as "userPhone",
              ${hasUserStatus ? sql`"u"."status" as "userStatus"` : sql`null::text as "userStatus"`},
              "w"."number" as "walletNumber"
            from "checkout_orders" "o"
            left join "users" "u" on "u"."id" = "o"."user_id"
            left join "wallets" "w" on "w"."id" = "o"."wallet_id"
            where "o"."ref" = ${ref}
            limit 1`,
      );
      if (!orderRow) return null;

      const order = mapOrderRecord(orderRow, now);

      // The ledger mirror the checkout flow writes for history/tracking. It is
      // absent for orders that never reached the provider-submit path — which
      // is exactly the parked case this page exists for, so "absent" is a
      // rendered fact and a finding, never a 404.
      const mirrorRow = await firstRow(
        tx,
        sql`${txColumnsSql("t", caps)}
            from "transactions" "t"
            left join "wallets" "w" on "w"."id" = "t"."wallet_id"
            left join "users" "u" on "u"."id" = "w"."user_id"
            where "t"."ref" = ${ref}
            limit 1`,
      );
      const mirror: AdminTransactionRow | null = mirrorRow
        ? toTransactionRow(mirrorRow, caps, { mask: false })
        : null;

      const recordedActions = refTrail ? await loadRecordedActionsByRef(tx, ref) : [];
      const accountActions = audit ? await loadAccountActions(tx, order.userId, refTrail) : [];

      const facts = orderFactsOf(order);
      const mirrorFacts = mirrorFactsFrom(mirror);
      const findings = diagnoseCheckoutOrder({
        order: facts,
        mirror: mirrorFacts,
        actions: recordedActions.map((entry) => ({ action: entry.action, at: entry.createdAt })),
        now,
      });

      // The customer-facing tracker, reused verbatim, so the admin timeline and
      // the customer timeline can never tell different stories.
      const tracking = buildTrackingInfo(orderToTrackable(facts, mirrorFacts), now);

      return {
        order,
        mirror,
        tracking: {
          phase: tracking.phase,
          progress: tracking.progress,
          overdue: tracking.overdue,
          etaLabel: tracking.etaLabel,
          stages: tracking.stages.map((stage) => ({
            id: stage.id,
            label: stage.label,
            hint: stage.hint,
            state: stage.state,
            at: stage.at,
          })),
        },
        findings,
        verdict: summarizeFindings(findings),
        recordedActions,
        accountActions,
        auditAvailable: audit,
        refTrailAvailable: refTrail,
        probe: probeAvailability(),
      } satisfies AdminOrderInvestigation;
    });
  }, "admin order investigation");
}

// ---------------------------------------------------------------------------
// 2. Deposit investigation
// ---------------------------------------------------------------------------

function mapDepositRecord(
  row: Record<string, unknown>,
  caps: AdminCaps,
): { deposit: AdminDepositRecord; credit: WalletCreditFacts } {
  const creditRows = Number(row.creditRows ?? 0);
  const successfulCredits = Number(row.creditOk ?? 0);
  const reversedRows = caps.reversedStatus ? Number(row.reversedRows ?? 0) : 0;
  const creditedAmount = row.creditedAmount === null || row.creditedAmount === undefined
    ? null
    : money2(row.creditedAmount);
  const creditedAt = iso(row.creditedAt);
  const walletCredit =
    reversedRows > 0 ? "reversed" : successfulCredits > 0 ? "credited" : "not-credited";

  const deposit: AdminDepositRecord = {
    id: Number(row.id),
    ref: String(row.ref ?? ""),
    walletId: Number(row.walletId),
    walletNumber: text(row.walletNumber),
    userId: intOr(row.userId),
    customerName: text(row.userName),
    customerEmail: text(row.userEmail) ?? "—",
    customerPhone: text(row.userPhone) ?? "—",
    provider: String(row.provider ?? ""),
    method: String(row.method ?? ""),
    amount: money2(row.amount),
    amountSubunits: intOr(row.amountSubunits),
    currency: text(row.currency) ?? "GHS",
    status: String(row.status ?? ""),
    paystackTransactionId: text(row.paystackTransactionId),
    paystackChannel: text(row.paystackChannel),
    paystackGatewayResponse: clampText(
      row.paystackGatewayResponse ? String(row.paystackGatewayResponse) : null,
      240,
    ),
    initiatedAt: iso(row.initiatedAt) ?? "",
    paidAt: iso(row.paidAt),
    verifiedAt: iso(row.verifiedAt),
    completedAt: iso(row.completedAt),
    updatedAt: iso(row.updatedAt),
    creditRows,
    successfulCredits,
    reversedRows,
    creditedAmount,
    creditedAt,
    walletCredit,
  };

  return {
    deposit,
    credit: {
      creditRows,
      successfulCredits,
      reversedRows,
      creditedAmount,
      creditedAt,
    },
  };
}

/**
 * One wallet funding attempt in full: the stored facts, the ledger rows that
 * carry its reference, the owning wallet's stored-vs-calculated verdict (the
 * SAME rule the reconciliation screen uses, so the two cannot disagree) and
 * the diagnosis.
 */
export async function loadDepositDetail(
  ref: string,
): Promise<AdminDepositInvestigation | null> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    const rule = reconciliationRule(caps);
    const audit = auditReadable(rawCaps);
    // Account history is readable on a database between 0002 and 0003; only the
    // order references need the later column.
    const refTrail = audit && hasSupportSchema(rawCaps);
    const now = Date.now();

    return withReadOnlyTx("admin.deposit-investigation", async (tx) => {
      const row = await firstRow(
        tx,
        sql`select
              "d"."id" as "id", "d"."ref" as "ref", "d"."wallet_id" as "walletId",
              "d"."provider" as "provider", "d"."method" as "method",
              "d"."amount"::text as "amount", "d"."amount_subunits" as "amountSubunits",
              "d"."currency" as "currency", "d"."status" as "status",
              "d"."paystack_transaction_id" as "paystackTransactionId",
              "d"."paystack_channel" as "paystackChannel",
              "d"."paystack_gateway_response" as "paystackGatewayResponse",
              "d"."initiated_at" as "initiatedAt", "d"."paid_at" as "paidAt",
              "d"."verified_at" as "verifiedAt", "d"."completed_at" as "completedAt",
              "d"."updated_at" as "updatedAt",
              "w"."number" as "walletNumber", "w"."balance"::text as "walletBalance",
              "u"."id" as "userId", "u"."name" as "userName",
              "u"."email" as "userEmail", "u"."phone" as "userPhone",
              (select count(*)::int from "transactions" "t"
                where "t"."ref" = "d"."ref" and "t"."direction" = 'in') as "creditRows",
              (select count(*)::int from "transactions" "t"
                where "t"."ref" = "d"."ref" and "t"."direction" = 'in'
                  and "t"."status" = 'successful') as "creditOk",
              ${
                caps.reversedStatus
                  ? sql`(select count(*)::int from "transactions" "t"
                          where "t"."ref" = "d"."ref" and "t"."status" = 'reversed')`
                  : sql`0::int`
              } as "reversedRows",
              (select "t"."amount"::text from "transactions" "t"
                where "t"."ref" = "d"."ref" and "t"."direction" = 'in'
                  and "t"."status" = 'successful'
                order by "t"."id" asc limit 1) as "creditedAmount",
              (select max("t"."created_at") from "transactions" "t"
                where "t"."ref" = "d"."ref" and "t"."direction" = 'in'
                  and "t"."status" = 'successful') as "creditedAt"
            from "deposit_requests" "d"
            left join "wallets" "w" on "w"."id" = "d"."wallet_id"
            left join "users" "u" on "u"."id" = "w"."user_id"
            where "d"."ref" = ${ref}
            limit 1`,
      );
      if (!row) return null;

      const { deposit, credit } = mapDepositRecord(row, caps);

      const creditRowList = await all<Record<string, unknown>>(
        tx,
        sql`${txColumnsSql("t", caps)}
            from "transactions" "t"
            left join "wallets" "w" on "w"."id" = "t"."wallet_id"
            left join "users" "u" on "u"."id" = "w"."user_id"
            where "t"."ref" = ${ref}
            order by "t"."id" asc
            limit ${CREDIT_ROW_LIMIT}`,
      );

      // The owning wallet's stored-vs-calculated verdict, using the existing
      // rule verbatim. Evidence for the investigator, never an accusation.
      const walletRow = await firstRow(
        tx,
        sql`select coalesce("w"."balance", 0)::text as "stored",
                   (select ${calculatedBalanceSql("t", caps)}::text
                      from "transactions" "t"
                     where "t"."wallet_id" = "w"."id") as "calculated",
                   (select count(*)::int from "transactions" "t"
                     where "t"."wallet_id" = "w"."id") as "counted"
            from "wallets" "w"
            where "w"."id" = ${deposit.walletId}
            limit 1`,
      );
      const stored = walletRow ? money2(walletRow.stored) : null;
      const calculated =
        walletRow && walletRow.calculated !== null && walletRow.calculated !== undefined
          ? money2(walletRow.calculated)
          : null;
      const verdict = classifyReconciliation({
        storedBalance: stored,
        calculatedBalance: calculated,
        examined: intOr(walletRow?.counted, 0),
        rule,
      });

      const facts: DepositFacts = {
        ref: deposit.ref,
        status: deposit.status,
        provider: deposit.provider,
        method: deposit.method,
        amount: deposit.amount,
        amountSubunits: deposit.amountSubunits,
        currency: deposit.currency,
        paystackTransactionId: deposit.paystackTransactionId,
        paystackGatewayResponse: deposit.paystackGatewayResponse,
        initiatedAt: deposit.initiatedAt,
        paidAt: deposit.paidAt,
        verifiedAt: deposit.verifiedAt,
        completedAt: deposit.completedAt,
        updatedAt: deposit.updatedAt,
      };
      const findings = diagnoseDeposit({ deposit: facts, credit, now });

      return {
        deposit,
        creditRows: creditRowList.map((entry) => toTransactionRow(entry, caps, { mask: false })),
        walletReconciliation: {
          available: walletRow !== null,
          storedBalance: stored,
          calculatedBalance: calculated,
          difference: verdict.difference,
          status: verdict.status,
          severity: verdict.severity,
          label: verdict.label,
          guidance: verdict.guidance,
        },
        findings,
        verdict: summarizeFindings(findings),
        accountActions: audit ? await loadAccountActions(tx, deposit.userId, refTrail) : [],
        auditAvailable: audit,
        probe: probeAvailability(),
      } satisfies AdminDepositInvestigation;
    });
  }, "admin deposit investigation");
}

// ---------------------------------------------------------------------------
// 3. Admin activity log
// ---------------------------------------------------------------------------

export type AuditQuery = {
  admin?: number | null;
  action?: string | null;
  userId?: number | null;
  search?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  page?: number;
  pageSize?: number;
};

const AUDIT_SORT = sql`"a"."created_at" desc, "a"."id" desc`;

function auditWhere(query: AuditQuery, refTrail: boolean): SQL {
  const term = query.search ?? "";
  const parts: Array<SQL | null> = [
    term
      ? sql`(${sql.join(
          [
            refTrail ? sql`coalesce("a"."target_ref", '') ilike ${likePattern(term)}` : null,
            sql`coalesce("a"."reason", '') ilike ${likePattern(term)}`,
            sql`coalesce("adm"."name", '') ilike ${likePattern(term)}`,
            sql`coalesce("adm"."email", '') ilike ${likePattern(term)}`,
            sql`coalesce("t"."name", '') ilike ${likePattern(term)}`,
            sql`coalesce("t"."email", '') ilike ${likePattern(term)}`,
          ].filter((part): part is SQL => part !== null),
          sql` or `,
        )})`
      : null,
    query.admin ? sql`"a"."admin_user_id" = ${query.admin}` : null,
    query.action ? sql`"a"."action" = ${query.action}` : null,
    query.userId ? sql`"a"."target_user_id" = ${query.userId}` : null,
    query.dateFrom ? sql`"a"."created_at" >= ${query.dateFrom}` : null,
    query.dateTo ? sql`"a"."created_at" <= ${query.dateTo}` : null,
  ];
  const active = parts.filter((part): part is SQL => part !== null);
  return active.length === 0 ? sql`true` : sql`${sql.join(active, sql` and `)}`;
}

function normalizeAuditQuery(query: AuditQuery): AuditQuery {
  return {
    ...query,
    search: parseSearch(query.search),
    admin: parseId(query.admin),
    userId: parseId(query.userId),
    action: parseEnum(query.action, AUDIT_ACTIONS),
    dateFrom: parseDateFrom(query.dateFrom),
    dateTo: parseDateTo(query.dateTo),
  };
}

/**
 * The administrator activity trail: every row of `admin_audit_logs`, newest
 * first, filterable by acting admin, action, target customer, reference and
 * date range.
 *
 * This is the read side of the accountability requirement. It changes nothing —
 * and the Step 3 harness asserts that reading it leaves the trail's row count
 * exactly as it was.
 */
export async function loadAdminAudit(input: AuditQuery): Promise<AdminAuditResult> {
  return withSchemaFallback(async (rawCaps) => {
    const available = auditReadable(rawCaps);
    const refTrail = available && hasSupportSchema(rawCaps);
    const query = normalizeAuditQuery(input);
    const pageSize = parsePageSize(query.pageSize);
    const page = Math.max(1, Math.trunc(query.page ?? 1));

    if (!available) {
      return {
        rows: [],
        total: 0,
        page,
        pageSize,
        available: false,
        refTrailAvailable: false,
        summary: { all: null, inRange: null, admins: null, byAction: [] },
        adminOptions: [],
        actionOptions: AUDIT_ACTIONS.map((action) => ({
          value: action,
          label: AUDIT_ACTION_LABELS[action] ?? action,
        })),
      } satisfies AdminAuditResult;
    }

    return withReadOnlyTx("admin.audit", async (tx) => {
      const where = auditWhere(query, refTrail);
      const from = sql`from "admin_audit_logs" "a"
            left join "users" "adm" on "adm"."id" = "a"."admin_user_id"
            left join "users" "t" on "t"."id" = "a"."target_user_id"`;

      const rows = await all<Record<string, unknown>>(
        tx,
        sql`select "a"."id" as "id", "a"."action" as "action", "a"."reason" as "reason",
                   ${refTrail ? sql`"a"."target_ref" as "targetRef"` : sql`null::text as "targetRef"`},
                   "a"."created_at" as "createdAt",
                   "a"."admin_user_id" as "adminUserId", "adm"."name" as "adminName",
                   "adm"."email" as "adminEmail",
                   "a"."target_user_id" as "targetUserId", "t"."name" as "targetName",
                   "t"."email" as "targetEmail"
            ${from}
            where ${where}
            order by ${AUDIT_SORT}
            limit ${pageSize} offset ${offsetFor(page, pageSize)}`,
      );

      const total = countRows(await tx.execute(sql`select count(*)::int as "c" ${from} where ${where}`));

      const summaryRow =
        (await firstRow(
          tx,
          sql`select count(*)::int as "inRange",
                     count(distinct "a"."admin_user_id")::int as "admins"
              ${from} where ${where}`,
        )) ?? {};

      const allRow =
        (await firstRow(
          tx,
          sql`select count(*)::int as "c" from "admin_audit_logs" "a"`,
        )) ?? {};

      const byAction = await all<{ action: string; c: number }>(
        tx,
        sql`select "a"."action" as "action", count(*)::int as "c"
            ${from} where ${where}
            group by "a"."action"
            order by count(*) desc, "a"."action" asc`,
      );

      const adminOptions = await all<{ id: number; name: string }>(
        tx,
        sql`select "u"."id" as "id", "u"."name" as "name"
            from "users" "u"
            where "u"."is_admin" = true
            order by "u"."name" asc, "u"."id" asc
            limit 50`,
      );

      return {
        // List view: masked. The acting admin's own name is shown in full
        // (admin-to-admin context, exactly as the support queue does).
        rows: rows.map((row) => {
          const action = String(row.action ?? "");
          const targetRef = text(row.targetRef);
          return {
            id: Number(row.id),
            action,
            actionLabel: AUDIT_ACTION_LABELS[action] ?? action,
            adminUserId: Number(row.adminUserId),
            adminName: clampText(row.adminName ? String(row.adminName) : null, 120),
            adminEmail: maskEmail(row.adminEmail),
            targetUserId: Number(row.targetUserId),
            targetName: clampText(row.targetName ? String(row.targetName) : null, 120),
            targetEmail: maskEmail(row.targetEmail),
            targetRef,
            targetKind: targetRef ? "order" : "account",
            reason: clampText(row.reason ? String(row.reason) : null, 240),
            createdAt: iso(row.createdAt) ?? "",
          } satisfies AdminAuditRow;
        }),
        total,
        page,
        pageSize,
        available: true,
        refTrailAvailable: refTrail,
        summary: {
          all: intOr(allRow.c),
          inRange: intOr(summaryRow.inRange),
          admins: intOr(summaryRow.admins),
          byAction: byAction.map((entry) => ({
            action: String(entry.action ?? ""),
            label: AUDIT_ACTION_LABELS[String(entry.action ?? "")] ?? String(entry.action ?? ""),
            count: Number(entry.c ?? 0),
          })),
        },
        adminOptions: adminOptions.map((entry) => ({
          id: Number(entry.id),
          name: String(entry.name ?? ""),
        })),
        actionOptions: AUDIT_ACTIONS.map((action) => ({
          value: action,
          label: AUDIT_ACTION_LABELS[action] ?? action,
        })),
      } satisfies AdminAuditResult;
    });
  }, "admin audit");
}

// ---------------------------------------------------------------------------
// 4. Refund-review backlog
// ---------------------------------------------------------------------------

export type RefundReviewQuery = {
  state?: string | null;
  search?: string;
  sort?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  page?: number;
  pageSize?: number;
};

/**
 * The review backlog, derived ENTIRELY from `admin_audit_logs` +
 * `checkout_orders`. Step 2's `refund_review` action writes no order column, so
 * "open" is defined here the same way `hasOpenRefundReview()` defines it: a
 * review with no `delivery_resolved` recorded at or after it.
 *
 * Nothing is stored, nothing is updated and no status column is invented.
 */
function reviewCte(refTrail: SQL): SQL {
  return sql`with "reviews" as (
        select "a"."target_ref" as "ref",
               count(*)::int as "review_count",
               min("a"."created_at") as "first_at",
               max("a"."created_at") as "last_at"
        from "admin_audit_logs" "a"
        where "a"."action" = 'refund_review' and "a"."target_ref" is not null
        group by "a"."target_ref"
      ), "resolutions" as (
        select "a"."target_ref" as "ref", max("a"."created_at") as "resolved_at"
        from "admin_audit_logs" "a"
        where "a"."action" = 'delivery_resolved' and "a"."target_ref" is not null
        group by "a"."target_ref"
      ), "joined" as (
        select "r"."ref" as "ref",
               "r"."review_count" as "reviewCount",
               "r"."first_at" as "firstReviewAt",
               "r"."last_at" as "lastReviewAt",
               "s"."resolved_at" as "resolvedAt",
               case when "s"."resolved_at" is not null and "s"."resolved_at" >= "r"."last_at"
                    then 'closed' else 'open' end as "state",
               "o"."id" as "orderId", "o"."order_status" as "orderStatus",
               "o"."payment_status" as "paymentStatus",
               "o"."amount" as "amount", "o"."currency" as "currency",
               "o"."network" as "network", "o"."plan_label" as "planLabel",
               "o"."recipient" as "recipient", "o"."created_at" as "orderCreatedAt",
               "u"."id" as "userId", "u"."name" as "userName", "u"."email" as "userEmail",
               (select "adm"."name" from "admin_audit_logs" "ra"
                  left join "users" "adm" on "adm"."id" = "ra"."admin_user_id"
                 where "ra"."target_ref" = "r"."ref" and "ra"."action" = 'refund_review'
                 order by "ra"."created_at" desc, "ra"."id" desc limit 1) as "reviewedBy",
               (select "ra"."reason" from "admin_audit_logs" "ra"
                 where "ra"."target_ref" = "r"."ref" and "ra"."action" = 'refund_review'
                   and "ra"."reason" is not null
                 order by "ra"."created_at" desc, "ra"."id" desc limit 1) as "reason"
        from "reviews" "r"
        left join "resolutions" "s" on "s"."ref" = "r"."ref"
        left join "checkout_orders" "o" on "o"."ref" = "r"."ref"
        left join "users" "u" on "u"."id" = "o"."user_id"
        where ${refTrail}
      )`;
}

const REVIEW_SORTS: Record<string, SQL> = {
  oldest: sql`(case when "state" = 'open' then 0 else 1 end) asc, "firstReviewAt" asc, "ref" asc`,
  recent: sql`"lastReviewAt" desc, "ref" asc`,
  amount: sql`(case when "state" = 'open' then 0 else 1 end) asc, coalesce("amount", 0) desc, "ref" asc`,
};

function reviewWhere(query: RefundReviewQuery): SQL {
  const term = query.search ?? "";
  const parts: Array<SQL | null> = [
    term
      ? sql`(${sql.join(
          [
            sql`coalesce("ref", '') ilike ${likePattern(term)}`,
            sql`coalesce("userName", '') ilike ${likePattern(term)}`,
            sql`coalesce("userEmail", '') ilike ${likePattern(term)}`,
            sql`coalesce("planLabel", '') ilike ${likePattern(term)}`,
          ],
          sql` or `,
        )})`
      : null,
    query.state ? sql`"state" = ${query.state}` : null,
    query.dateFrom ? sql`"firstReviewAt" >= ${query.dateFrom}` : null,
    query.dateTo ? sql`"firstReviewAt" <= ${query.dateTo}` : null,
  ];
  const active = parts.filter((part): part is SQL => part !== null);
  return active.length === 0 ? sql`true` : sql`${sql.join(active, sql` and `)}`;
}

function normalizeReviewQuery(query: RefundReviewQuery): RefundReviewQuery {
  return {
    ...query,
    search: parseSearch(query.search),
    state: parseEnum(query.state, ["open", "closed"] as const),
    sort: parseEnum(query.sort, ["oldest", "recent", "amount"] as const),
    dateFrom: parseDateFrom(query.dateFrom),
    dateTo: parseDateTo(query.dateTo),
  };
}

function mapReviewRow(row: Record<string, unknown>, now: number): AdminRefundReviewRow {
  const state = String(row.state ?? "open") === "closed" ? "closed" : "open";
  const firstReviewAt = iso(row.firstReviewAt) ?? "";
  const firstMs = toMs(firstReviewAt);
  return {
    ref: String(row.ref ?? ""),
    orderId: intOr(row.orderId),
    userId: intOr(row.userId),
    customerName: text(row.userName),
    customerEmail: maskEmail(row.userEmail),
    phone: maskPhone(row.recipient),
    network: text(row.network),
    bundle: text(row.planLabel) ?? "—",
    amount: row.amount === null || row.amount === undefined ? 0 : money2(row.amount),
    currency: text(row.currency) ?? "GHS",
    orderStatus: text(row.orderStatus),
    paymentStatus: text(row.paymentStatus),
    state,
    reviewCount: Number(row.reviewCount ?? 1),
    firstReviewAt,
    lastReviewAt: iso(row.lastReviewAt),
    resolvedAt: iso(row.resolvedAt),
    ageHours:
      state === "open" && firstMs !== null
        ? Math.max(0, Math.floor((now - firstMs) / 3_600_000))
        : null,
    reviewedBy: clampText(row.reviewedBy ? String(row.reviewedBy) : null, 120),
    reason: clampText(row.reason ? String(row.reason) : null, 240),
    orderCreatedAt: iso(row.orderCreatedAt),
  };
}

export async function loadRefundReviews(
  input: RefundReviewQuery,
): Promise<AdminRefundReviewResult> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    const available = auditReadable(rawCaps) && hasSupportSchema(rawCaps) && caps.checkoutTable;
    const query = normalizeReviewQuery(input);
    const pageSize = parsePageSize(query.pageSize);
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const now = Date.now();

    const empty = {
      rows: [] as AdminRefundReviewRow[],
      total: 0,
      page,
      pageSize,
      available: false,
      summary: { open: null, closed: null, openValue: null, oldestOpenHours: null },
    } satisfies AdminRefundReviewResult;
    if (!available) return empty;

    const cte = reviewCte(sql`true`);
    const where = reviewWhere(query);
    const sort = REVIEW_SORTS[query.sort ?? "oldest"] ?? REVIEW_SORTS.oldest;

    return withReadOnlyTx("admin.refund-reviews", async (tx) => {
      const rows = await all<Record<string, unknown>>(
        tx,
        sql`${cte}
            select * from "joined"
            where ${where}
            order by ${sort}
            limit ${pageSize} offset ${offsetFor(page, pageSize)}`,
      );
      const total = countRows(
        await tx.execute(sql`${cte} select count(*)::int as "c" from "joined" where ${where}`),
      );
      // The summary is deliberately UNFILTERED: "how much money is waiting on a
      // decision" is a property of the backlog, not of the current filter.
      const summaryRow =
        (await firstRow(
          tx,
          sql`${cte}
              select count(*) filter (where "state" = 'open')::int as "open",
                     count(*) filter (where "state" = 'closed')::int as "closed",
                     coalesce(sum("amount") filter (where "state" = 'open'), 0)::text as "openValue",
                     max(case when "state" = 'open'
                              then extract(epoch from (now() - "firstReviewAt")) / 3600 end) as "oldestOpenHours"
              from "joined"`,
        )) ?? {};

      return {
        rows: rows.map((row) => mapReviewRow(row, now)),
        total,
        page,
        pageSize,
        available: true,
        summary: {
          open: intOr(summaryRow.open),
          closed: intOr(summaryRow.closed),
          openValue:
            summaryRow.openValue === undefined ? null : money2(summaryRow.openValue),
          oldestOpenHours:
            summaryRow.oldestOpenHours === null || summaryRow.oldestOpenHours === undefined
              ? null
              : Math.max(0, Math.floor(Number(summaryRow.oldestOpenHours))),
        },
      } satisfies AdminRefundReviewResult;
    });
  }, "admin refund reviews");
}
