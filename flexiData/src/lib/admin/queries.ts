import "server-only";

import { sql, type SQL } from "drizzle-orm";
import {
  CHECKOUT_ORDERS_COLUMNS,
  getSchemaCapabilities,
  hasTableColumns,
  hasTransactionColumn,
  supportsTxStatusValue,
  withSchemaFallback,
  type SchemaCapabilities,
} from "@/lib/schema-compat";
import { paystackMode } from "@/lib/paystack";
import { withReadOnlyTx, countRows, iso, money2, type AdminExecutor } from "@/lib/admin/db";
import {
  RECONCILIATION_CAUSES,
  calculatedBalanceSql,
  classifyReconciliation,
  lastMovedAtSql,
  movedCountSql,
  moneyMovedSql,
  reconciliationRule,
  type ReconciliationCapabilities,
  type ReconciliationRule,
} from "@/lib/admin/reconciliation";
import { clampText, maskEmail, maskPhone } from "@/lib/admin/redact";
import { likePattern, offsetFor, parsePageSize, parseSearch, type AdminList } from "@/lib/admin/filters";
import type {
  AdminCapsView,
  AdminFloatRow,
  AdminIssue,
  AdminOverview,
  AdminOverviewCounts,
  AdminReconciliationResult,
  AdminReconciliationRow,
  AdminTransactionRow,
  AdminUserDetail,
  AdminUserRow,
  AdminUserSessionRow,
  AdminUserWalletRow,
  AdminWalletDetail,
  AdminWalletRow,
} from "@/lib/admin/types";

/**
 * Phase 1 admin read layer — overview, wallets, reconciliation and users.
 *
 * Rules every function here follows:
 *
 *  1. **Read-only.** All statements run inside {@link withReadOnlyTx}, i.e. a
 *     `SET TRANSACTION READ ONLY` transaction, and are additionally checked by
 *     the statement guard in `src/lib/admin/db.ts`.
 *  2. **Schema-drift aware.** The gateway columns (`charged_at`,
 *     `fulfillment_status`, `provider_*`) may not exist on a lagging database.
 *     Rather than white-screening the dashboard, the affected metric comes back
 *     as `null` and the UI renders "Not available".
 *  3. **Bound parameters only.** Every operator-supplied value is passed as a
 *     query parameter; SQL text is built from constants in this file.
 *  4. **Minimum PII.** List rows carry masked emails/phone numbers. Raw provider
 *     JSON payloads are never selected.
 *  5. **No N+1.** Every list is one query for the page plus one for the total;
 *     per-row lookups use correlated subqueries or grouped joins.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type AdminCaps = ReconciliationCapabilities & {
  fulfilledAt: boolean;
  fulfillmentStatus: boolean;
  lastProviderSyncAt: boolean;
  provider: boolean;
  providerReference: boolean;
  providerStatus: boolean;
  providerMessage: boolean;
  /** The `tx_status` enum accepts `reversed`. */
  reversedStatus: boolean;
  floatTable: boolean;
  checkoutTable: boolean;
};

export function toAdminCaps(caps: SchemaCapabilities): AdminCaps {
  return {
    chargedAt: hasTransactionColumn(caps, "chargedAt"),
    refundedAt: hasTransactionColumn(caps, "refundedAt"),
    fulfilledAt: hasTransactionColumn(caps, "fulfilledAt"),
    fulfillmentStatus: hasTransactionColumn(caps, "fulfillmentStatus"),
    lastProviderSyncAt: hasTransactionColumn(caps, "lastProviderSyncAt"),
    provider: hasTransactionColumn(caps, "provider"),
    providerReference: hasTransactionColumn(caps, "providerReference"),
    providerStatus: hasTransactionColumn(caps, "providerStatus"),
    providerMessage: hasTransactionColumn(caps, "providerMessage"),
    reversedStatus: supportsTxStatusValue(caps, "reversed"),
    floatTable: caps.floatTable,
    checkoutTable: hasTableColumns(caps, "checkout_orders", CHECKOUT_ORDERS_COLUMNS),
  };
}

function capsView(caps: AdminCaps, rule: ReconciliationRule): AdminCapsView {
  return {
    chargedAt: caps.chargedAt,
    refundedAt: caps.refundedAt,
    fulfilledAt: caps.fulfilledAt,
    fulfillmentStatus: caps.fulfillmentStatus,
    lastProviderSyncAt: caps.lastProviderSyncAt,
    reversedStatus: caps.reversedStatus,
    checkoutTable: caps.checkoutTable,
    floatTable: caps.floatTable,
    reconciliation: { id: rule.id, label: rule.label, exact: rule.exact, note: rule.note },
  };
}

export async function loadAdminCaps(): Promise<AdminCaps> {
  return toAdminCaps(await getSchemaCapabilities());
}

// ---------------------------------------------------------------------------
// Small statement helpers
// ---------------------------------------------------------------------------

async function all<T extends Record<string, unknown>>(tx: AdminExecutor, query: SQL): Promise<T[]> {
  const result = await tx.execute<T>(query);
  return result.rows ?? [];
}

async function first<T extends Record<string, unknown>>(
  tx: AdminExecutor,
  query: SQL,
): Promise<T | null> {
  return (await all<T>(tx, query))[0] ?? null;
}

function whereAll(parts: Array<SQL | null>): SQL {
  const active = parts.filter((part): part is SQL => part !== null);
  if (active.length === 0) return sql`true`;
  return sql`${sql.join(active, sql` and `)}`;
}

/** `coalesce(col,'') ilike $pattern` across several columns, OR-ed together. */
function searchAny(term: string, columns: SQL[]): SQL | null {
  if (!term) return null;
  const pattern = likePattern(term);
  return sql`(${sql.join(
    columns.map((column) => sql`coalesce(${column}, '') ilike ${pattern}`),
    sql` or `,
  )})`;
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

// ---------------------------------------------------------------------------
// 1. Overview
// ---------------------------------------------------------------------------

/**
 * The number of wallets whose stored balance disagrees with the ledger-derived
 * figure. Uses the SAME `moneyMovedSql` rule the reconciliation screen uses, so
 * the tile and the screen can never report different numbers.
 */
function discrepancyCountSql(caps: AdminCaps): SQL {
  const moved = moneyMovedSql("t", caps);
  return sql`(select count(*)::int from (
      select "w"."id"
      from "wallets" "w"
      left join (
        select "t"."wallet_id" as "wallet_id",
               ${calculatedBalanceSql("t", caps)} as "calculated"
        from "transactions" "t"
        group by "t"."wallet_id"
      ) "l" on "l"."wallet_id" = "w"."id"
      where abs(coalesce("l"."calculated", 0) - "w"."balance") > 0.005
    ) "d")`;
}

export async function loadOverview(): Promise<AdminOverview> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    const rule = reconciliationRule(caps);

    return withReadOnlyTx("admin.overview", async (tx) => {
      const columns: SQL[] = [
        sql`(select count(*)::int from "users") as "users"`,
        sql`(select count(*)::int from "wallets") as "wallets"`,
        sql`(select coalesce(sum("balance"), 0)::text from "wallets") as "totalWalletBalance"`,
        sql`(select count(*)::int from "deposit_requests" where "status" = 'successful') as "successfulDeposits"`,
        sql`(select coalesce(sum("amount"), 0)::text from "deposit_requests" where "status" = 'successful') as "successfulDepositsValue"`,
        sql`(select count(*)::int from "deposit_requests" where "status" = 'pending') as "pendingDeposits"`,
        sql`(select count(*)::int from "deposit_requests" where "status" = 'failed') as "failedDeposits"`,
        sql`(select count(*)::int from "deposit_requests" where "status" = 'abandoned') as "abandonedDeposits"`,
        sql`(select count(*)::int from "transactions" where "type" in ('data', 'airtime') and "status" = 'successful') as "successfulPurchases"`,
        sql`(select coalesce(sum("amount"), 0)::text from "transactions" where "type" in ('data', 'airtime') and "status" = 'successful') as "successfulPurchasesValue"`,
        sql`(select count(*)::int from "transactions" where "status" = 'pending') as "pendingTransactions"`,
        sql`(select count(*)::int from "transactions" where "status" = 'failed') as "failedTransactions"`,
        // Only meaningful when the enum actually has the label: comparing
        // against 'reversed' on a legacy enum raises 22P02.
        caps.reversedStatus
          ? sql`(select count(*)::int from "transactions" where "status" = 'reversed') as "reversedTransactions"`
          : sql`null::int as "reversedTransactions"`,
      ];

      if (caps.fulfillmentStatus) {
        columns.push(
          // Delivery states are only meaningful for bundles and airtime; a
          // wallet transfer carries the same enum but is not a delivery.
          sql`(select count(*)::int from "transactions" where "type" in ('data', 'airtime') and "fulfillment_status" in ('queued', 'submitted', 'processing')) as "pendingDeliveries"`,
          sql`(select count(*)::int from "transactions" where "type" in ('data', 'airtime') and "fulfillment_status" = 'failed') as "failedDeliveries"`,
        );
      } else {
        columns.push(
          sql`null::int as "pendingDeliveries"`,
          sql`null::int as "failedDeliveries"`,
        );
      }

      if (caps.checkoutTable) {
        columns.push(
          sql`(select count(*)::int from "checkout_orders" where "order_status" = 'fulfilled') as "fulfilledCheckoutOrders"`,
          sql`(select count(*)::int from "checkout_orders" where "order_status" in ('paid', 'fulfilling')) as "inFlightCheckoutOrders"`,
          sql`(select count(*)::int from "checkout_orders" where "order_status" in ('paid', 'fulfilling') and "updated_at" < now() - interval '2 hours') as "stuckCheckoutOrders"`,
          sql`(select count(*)::int from "checkout_orders" where "order_status" = 'fulfillment_failed') as "supportQueue"`,
        );
      } else {
        columns.push(
          sql`null::int as "fulfilledCheckoutOrders"`,
          sql`null::int as "inFlightCheckoutOrders"`,
          sql`null::int as "stuckCheckoutOrders"`,
          sql`null::int as "supportQueue"`,
        );
      }

      columns.push(sql`${discrepancyCountSql(caps)} as "walletDiscrepancies"`);

      const row = (await first<Record<string, unknown>>(tx, sql`select ${sql.join(columns, sql`, `)}`)) ?? {};

      const counts: AdminOverviewCounts = {
        users: nullableInt(row.users),
        wallets: nullableInt(row.wallets),
        totalWalletBalance: nullableMoney(row.totalWalletBalance),
        successfulDeposits: nullableInt(row.successfulDeposits),
        successfulDepositsValue: nullableMoney(row.successfulDepositsValue),
        pendingDeposits: nullableInt(row.pendingDeposits),
        failedDeposits: nullableInt(row.failedDeposits),
        abandonedDeposits: nullableInt(row.abandonedDeposits),
        successfulPurchases: nullableInt(row.successfulPurchases),
        successfulPurchasesValue: nullableMoney(row.successfulPurchasesValue),
        fulfilledCheckoutOrders: nullableInt(row.fulfilledCheckoutOrders),
        pendingTransactions: nullableInt(row.pendingTransactions),
        failedTransactions: nullableInt(row.failedTransactions),
        reversedTransactions: nullableInt(row.reversedTransactions),
        pendingDeliveries: nullableInt(row.pendingDeliveries),
        failedDeliveries: nullableInt(row.failedDeliveries),
        inFlightCheckoutOrders: nullableInt(row.inFlightCheckoutOrders),
        stuckCheckoutOrders: nullableInt(row.stuckCheckoutOrders),
        supportQueue: nullableInt(row.supportQueue),
        walletDiscrepancies: nullableInt(row.walletDiscrepancies ?? row.discrepancy ?? null),
      };

      const float = caps.floatTable
        ? await all<Record<string, unknown>>(
            tx,
            sql`select "id", "provider_code", "network", "available_balance"::text as "available_balance",
                       "reserved_balance"::text as "reserved_balance",
                       "low_balance_threshold"::text as "low_balance_threshold",
                       "last_reference", "last_status", "last_synced_at"
                from "provider_float_balances"
                order by "network" asc`,
          )
        : [];

      return {
        generatedAt: new Date().toISOString(),
        paystackMode: paystackMode(),
        counts,
        issues: buildIssues(counts, float),
        float: {
          available: caps.floatTable,
          rows: float.map(toFloatRow),
        },
        caps: capsView(caps, rule),
      } satisfies AdminOverview;
    });
  }, "admin overview");
}

/**
 * Counts for the "Requires support" badge in the admin navigation.
 *
 * Deliberately the cheapest possible query (one pass over `checkout_orders`,
 * which is indexed on `order_status`) because the layout runs it on every admin
 * page. Anything that needs a ledger scan belongs on the overview, not here.
 */
export async function loadNavBadges(): Promise<{ support: number | null; stuck: number | null }> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    if (!caps.checkoutTable) return { support: null, stuck: null };
    return withReadOnlyTx("admin.nav", async (tx) => {
      const row = await first<Record<string, unknown>>(
        tx,
        sql`select
              count(*) filter (where "order_status" = 'fulfillment_failed')::int as "support",
              count(*) filter (where "order_status" in ('paid', 'fulfilling')
                                and "updated_at" < ${new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()}::timestamptz)::int as "stuck"
            from "checkout_orders"`,
      );
      return {
        support: row?.support === null || row?.support === undefined ? null : Number(row.support),
        stuck: row?.stuck === null || row?.stuck === undefined ? null : Number(row.stuck),
      };
    });
  }, "admin nav badges");
}

function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return money2(value);
}

function nullableMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return money2(value);
}

function toFloatRow(row: Record<string, unknown>): AdminFloatRow {
  const available = money2(row.available_balance);
  const threshold = money2(row.low_balance_threshold);
  return {
    id: Number(row.id),
    providerCode: String(row.provider_code ?? ""),
    network: String(row.network ?? ""),
    availableBalance: available,
    reservedBalance: money2(row.reserved_balance),
    lowBalanceThreshold: threshold,
    lastReference: text(row.last_reference),
    lastStatus: text(row.last_status),
    lastSyncedAt: iso(row.last_synced_at),
    belowThreshold: threshold > 0 && available <= threshold,
  };
}

/**
 * Operational problems first. Cosmetic statistics never appear here — an
 * operator opening /admin should see what is broken before anything else.
 */
function buildIssues(counts: AdminOverviewCounts, float: Record<string, unknown>[]): AdminIssue[] {
  const issues: AdminIssue[] = [];
  const add = (
    id: string,
    label: string,
    count: number | null,
    severity: AdminIssue["severity"],
    detail: string,
    href: string,
  ) => {
    if (count === null || count <= 0) return;
    issues.push({ id, label, count, severity, detail, href });
  };

  add(
    "support-queue",
    "Orders requiring support",
    counts.supportQueue,
    "critical",
    "Paid orders parked as `fulfillment_failed` by the checkout flow. They are never auto-retried and need manual resolution.",
    "/admin/attention",
  );
  add(
    "wallet-discrepancies",
    "Wallet discrepancies",
    counts.walletDiscrepancies,
    "critical",
    "Stored wallet balance does not match the balance calculated from the ledger.",
    "/admin/reconciliation?only=mismatches",
  );
  add(
    "stuck-orders",
    "Paid orders stuck in fulfilment",
    counts.stuckCheckoutOrders,
    "critical",
    "Orders paid more than two hours ago that are still `paid`/`fulfilling`.",
    "/admin/attention",
  );
  add(
    "failed-deliveries",
    "Failed data deliveries",
    counts.failedDeliveries,
    "critical",
    "Ledger rows whose `fulfillment_status` is `failed`.",
    "/admin/data?status=failed",
  );
  add(
    "failed-deposits",
    "Failed deposits",
    counts.failedDeposits,
    "attention",
    "Includes Paystack verification mismatches that were parked instead of credited.",
    "/admin/payments?status=failed",
  );
  add(
    "pending-deliveries",
    "Deliveries in flight",
    counts.pendingDeliveries,
    "attention",
    "Orders accepted but not yet delivered to the recipient.",
    "/admin/data?status=pending",
  );
  add(
    "pending-transactions",
    "Pending transactions",
    counts.pendingTransactions,
    "attention",
    "Ledger rows that have not reached a terminal state.",
    "/admin/transactions?status=pending",
  );
  add(
    "pending-deposits",
    "Pending deposits",
    counts.pendingDeposits,
    "attention",
    "Funding attempts that have not been confirmed by the provider.",
    "/admin/payments?status=pending",
  );

  const lowFloat = float.filter((row) => {
    const threshold = money2(row.low_balance_threshold);
    return threshold > 0 && money2(row.available_balance) <= threshold;
  });
  if (lowFloat.length > 0) {
    issues.push({
      id: "provider-float",
      label: "Provider float below threshold",
      count: lowFloat.length,
      severity: "attention",
      detail: `Networks at or below their configured low-balance threshold: ${lowFloat
        .map((row) => String(row.network))
        .join(", ")}.`,
      href: "/admin",
    });
  }

  // Severity first, then the hand-authored order above — which is an operational
  // priority (money already taken and a customer waiting comes before a
  // statistical mismatch), deliberately NOT a sort by count.
  const rank: Record<AdminIssue["severity"], number> = { critical: 0, attention: 1, healthy: 2, unknown: 3 };
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => rank[a.issue.severity] - rank[b.issue.severity] || a.index - b.index)
    .map((entry) => entry.issue);
}

// ---------------------------------------------------------------------------
// 2. Wallets
// ---------------------------------------------------------------------------

const WALLET_SORTS: Record<string, SQL> = {
  difference: sql`abs(coalesce("l"."calculated", 0) - "w"."balance") desc nulls last, "w"."id" desc`,
  balance: sql`"w"."balance" desc, "w"."id" desc`,
  recent: sql`"w"."created_at" desc, "w"."id" desc`,
  id: sql`"w"."id" asc`,
};

function walletLedgerJoin(caps: AdminCaps): SQL {
  return sql`left join (
      select "t"."wallet_id" as "wallet_id",
             ${calculatedBalanceSql("t", caps)} as "calculated",
             ${movedCountSql("t", caps)}::int as "counted",
             ${lastMovedAtSql("t", caps)} as "last_at"
      from "transactions" "t"
      group by "t"."wallet_id"
    ) "l" on "l"."wallet_id" = "w"."id"`;
}

type WalletRowSql = {
  walletId: number;
  walletName: string;
  walletNumber: string;
  storedBalance: string;
  points: number;
  isAgent: boolean;
  agentTier: string | null;
  createdAt: string;
  userId: number | null;
  userName: string | null;
  userEmail: string | null;
  userPhone: string | null;
  calculated: string | null;
  counted: number | null;
  last_at: string | null;
};

function toWalletRow(row: WalletRowSql, rule: ReconciliationRule): AdminWalletRow {
  const stored = money2(row.storedBalance);
  const calculated = row.calculated === null ? null : money2(row.calculated);
  const verdict = classifyReconciliation({
    storedBalance: stored,
    calculatedBalance: calculated,
    examined: row.counted ?? null,
    rule,
  });
  return {
    walletId: Number(row.walletId),
    walletName: String(row.walletName ?? ""),
    walletNumber: String(row.walletNumber ?? ""),
    userId: row.userId === null ? null : Number(row.userId),
    userName: row.userName ? String(row.userName) : null,
    userEmail: maskEmail(row.userEmail),
    userPhone: maskPhone(row.userPhone),
    storedBalance: stored,
    points: Number(row.points ?? 0),
    calculatedBalance: calculated,
    difference: verdict.difference,
    diffStatus: verdict.status,
    transactionsExamined: row.counted === null ? null : Number(row.counted),
    lastTransactionAt: iso(row.last_at),
    isAgent: Boolean(row.isAgent),
    agentTier: row.agentTier ? String(row.agentTier) : null,
    createdAt: iso(row.createdAt) ?? "",
  };
}

export type WalletQuery = {
  search?: string;
  sort?: string;
  onlyMismatches?: boolean;
  page?: number;
  pageSize?: number;
};

export async function loadWallets(query: WalletQuery): Promise<AdminList<AdminWalletRow>> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    const rule = reconciliationRule(caps);
    const term = parseSearch(query.search);
    const pageSize = parsePageSize(query.pageSize);
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const sort = WALLET_SORTS[query.sort ?? ""] ?? WALLET_SORTS.difference;

    return withReadOnlyTx("admin.wallets", async (tx) => {
      const search = searchAny(term, [
        sql`"w"."number"`,
        sql`"u"."name"`,
        sql`"u"."email"`,
        sql`"u"."phone"`,
      ]);
      const idMatch = /^\d+$/.test(term)
        ? sql`("w"."id" = ${Number(term)} or "u"."id" = ${Number(term)})`
        : null;
      const mismatch = query.onlyMismatches
        ? sql`abs(coalesce("l"."calculated", 0) - "w"."balance") > 0.005`
        : null;
      const where = whereAll([search || idMatch ? sql`(${sql.join([search, idMatch].filter(Boolean) as SQL[], sql` or `)})` : null, mismatch]);

      const columns = sql`select
        "w"."id" as "walletId", "w"."name" as "walletName", "w"."number" as "walletNumber",
        "w"."balance"::text as "storedBalance", "w"."points" as "points",
        "w"."is_agent" as "isAgent", "w"."agent_tier" as "agentTier", "w"."created_at" as "createdAt",
        "u"."id" as "userId", "u"."name" as "userName", "u"."email" as "userEmail", "u"."phone" as "userPhone",
        "l"."calculated"::text as "calculated", "l"."counted" as "counted", "l"."last_at" as "last_at"`;

      const rows = await all<WalletRowSql>(
        tx,
        sql`${columns}
            from "wallets" "w"
            left join "users" "u" on "u"."id" = "w"."user_id"
            ${walletLedgerJoin(caps)}
            where ${where}
            order by ${sort}
            limit ${pageSize} offset ${offsetFor(page, pageSize)}`,
      );

      const total = countRows(
        await tx.execute(
          sql`select count(*)::int as "c"
              from "wallets" "w"
              left join "users" "u" on "u"."id" = "w"."user_id"
              ${walletLedgerJoin(caps)}
              where ${where}`,
        ),
      );

      return { rows: rows.map((row) => toWalletRow(row, rule)), total, page, pageSize };
    });
  }, "admin wallets");
}

export async function loadWalletDetail(
  walletId: number,
  page = 1,
  pageSize = 25,
): Promise<AdminWalletDetail | null> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    const rule = reconciliationRule(caps);

    return withReadOnlyTx("admin.wallet-detail", async (tx) => {
      const walletRow = await first<WalletRowSql>(
        tx,
        sql`select
              "w"."id" as "walletId", "w"."name" as "walletName", "w"."number" as "walletNumber",
              "w"."balance"::text as "storedBalance", "w"."points" as "points",
              "w"."is_agent" as "isAgent", "w"."agent_tier" as "agentTier", "w"."created_at" as "createdAt",
              "u"."id" as "userId", "u"."name" as "userName", "u"."email" as "userEmail", "u"."phone" as "userPhone",
              "l"."calculated"::text as "calculated", "l"."counted" as "counted", "l"."last_at" as "last_at"
            from "wallets" "w"
            left join "users" "u" on "u"."id" = "w"."user_id"
            ${walletLedgerJoin(caps)}
            where "w"."id" = ${walletId}
            limit 1`,
      );
      if (!walletRow) return null;

      // A single-record view: the operator has deliberately opened this wallet,
      // so the real contact details are shown rather than the masked ones.
      const wallet: AdminWalletRow = {
        ...toWalletRow(walletRow, rule),
        userEmail: walletRow.userEmail ? String(walletRow.userEmail) : "—",
        userPhone: walletRow.userPhone ? String(walletRow.userPhone) : "—",
      };

      const stored = money2(walletRow.storedBalance);
      const calculated = walletRow.calculated === null ? null : money2(walletRow.calculated);
      const verdict = classifyReconciliation({
        storedBalance: stored,
        calculatedBalance: calculated,
        examined: walletRow.counted ?? null,
        rule,
      });

      const totalsRow =
        (await first<Record<string, unknown>>(
          tx,
          sql`select
                coalesce(sum("amount") filter (where "direction" = 'in' and "status" = 'successful'), 0)::text as "credits",
                coalesce(sum("amount") filter (where "direction" = 'out' and "status" = 'successful'), 0)::text as "debits",
                count(*) filter (where "direction" = 'in' and "status" = 'successful')::int as "creditCount",
                count(*) filter (where "direction" = 'out' and "status" = 'successful')::int as "debitCount",
                count(*) filter (where ${moneyMovedSql("t", caps)} and "direction" = 'in')::int as "movedIn",
                count(*) filter (where ${moneyMovedSql("t", caps)} and "direction" = 'out')::int as "movedOut",
                ${
                  caps.reversedStatus
                    ? sql`count(*) filter (where "status" = 'reversed' or "refunded_at" is not null)::int`
                    : sql`count(*) filter (where "refunded_at" is not null)::int`
                } as "reversals"
              from "transactions" "t"
              where "t"."wallet_id" = ${walletId}`,
        )) ?? {};

      const contributions = await loadWalletContributions(tx, caps, walletId, page, pageSize);

      return {
        wallet,
        reconciliation: {
          rule: { id: rule.id, label: rule.label, exact: rule.exact, note: rule.note },
          storedBalance: stored,
          calculatedBalance: calculated,
          difference: verdict.difference,
          status: verdict.status,
          severity: verdict.severity,
          label: verdict.label,
          guidance: verdict.guidance,
          transactionsExamined: walletRow.counted === null ? null : Number(walletRow.counted),
          lastTransactionAt: iso(walletRow.last_at),
          causes: RECONCILIATION_CAUSES,
        },
        totals: {
          credits: money2(totalsRow.credits),
          debits: money2(totalsRow.debits),
          successfulCredits: Number(totalsRow.creditCount ?? 0),
          successfulDebits: Number(totalsRow.debitCount ?? 0),
          reversals: Number(totalsRow.reversals ?? 0),
        },
        contributions: contributions.rows,
        contributionsTotal: contributions.total,
        page: contributions.page,
        pageSize: contributions.pageSize,
      } satisfies AdminWalletDetail;
    });
  }, "admin wallet detail");
}

/**
 * The ledger rows that actually fed the calculated balance — shown so an
 * investigator can see what was summed. They are *evidence*, not an accusation:
 * the UI must never claim one of them is the cause.
 */
async function loadWalletContributions(
  tx: AdminExecutor,
  caps: AdminCaps,
  walletId: number,
  page: number,
  pageSize: number,
): Promise<AdminList<AdminTransactionRow>> {
  const rows = await all<Record<string, unknown>>(
    tx,
    sql`${txColumnsSql("t", caps)}
        from "transactions" "t"
        left join "wallets" "w" on "w"."id" = "t"."wallet_id"
        left join "users" "u" on "u"."id" = "w"."user_id"
        where "t"."wallet_id" = ${walletId} and ${moneyMovedSql("t", caps)}
        order by "t"."created_at" desc, "t"."id" desc
        limit ${pageSize} offset ${offsetFor(page, pageSize)}`,
  );
  const total = countRows(
    await tx.execute(
      sql`select count(*)::int as "c" from "transactions" "t"
          where "t"."wallet_id" = ${walletId} and ${moneyMovedSql("t", caps)}`,
    ),
  );
  return {
    rows: rows.map((row) => toTransactionRow(row, caps, { mask: true })),
    total,
    page: Math.max(1, page),
    pageSize,
  };
}

// ---------------------------------------------------------------------------
// 3. Transactions — shared column list (also used by the wallet/user screens)
// ---------------------------------------------------------------------------

export function txColumnsSql(alias: string, caps: AdminCaps): SQL {
  const a = (column: string) => sql.raw(`"${alias}"."${column}"`);
  const optional = (present: boolean, column: string, name: string): SQL =>
    present ? sql`${sql.raw(`"${alias}"."${column}"`)} as ${sql.raw(`"${name}"`)}` : sql`null::text as ${sql.raw(`"${name}"`)}`;

  return sql`select
    ${a("id")} as "id",
    ${a("ref")} as "ref",
    ${a("wallet_id")} as "walletId",
    ${a("type")} as "type",
    ${a("status")} as "status",
    ${a("direction")} as "direction",
    ${a("title")} as "title",
    ${a("subtitle")} as "subtitle",
    ${a("amount")}::text as "amount",
    ${a("points")} as "points",
    ${a("network")} as "network",
    ${a("recipient")} as "recipient",
    ${a("created_at")} as "createdAt",
    ${optional(caps.fulfillmentStatus, "fulfillment_status", "fulfillmentStatus")},
    ${optional(caps.provider, "provider", "provider")},
    ${optional(caps.providerReference, "provider_reference", "providerReference")},
    ${optional(caps.providerStatus, "provider_status", "providerStatus")},
    ${optional(caps.chargedAt, "charged_at", "chargedAt")},
    ${optional(caps.fulfilledAt, "fulfilled_at", "fulfilledAt")},
    ${optional(caps.refundedAt, "refunded_at", "refundedAt")},
    "w"."number" as "walletNumber",
    "u"."id" as "userId",
    "u"."name" as "userName",
    "u"."email" as "userEmail",
    "u"."phone" as "userPhone"`;
}

export type TransactionMaskPolicy = { mask: boolean };

export function toTransactionRow(
  row: Record<string, unknown>,
  caps: AdminCaps,
  policy: TransactionMaskPolicy,
): AdminTransactionRow {
  const chargedAt = iso(row.chargedAt);
  return {
    id: Number(row.id),
    ref: String(row.ref ?? ""),
    walletId: Number(row.walletId),
    walletNumber: text(row.walletNumber),
    userId: row.userId === null || row.userId === undefined ? null : Number(row.userId),
    userName: text(row.userName),
    userEmail: policy.mask ? maskEmail(row.userEmail) : text(row.userEmail) ?? "—",
    type: String(row.type ?? ""),
    status: String(row.status ?? ""),
    direction: String(row.direction ?? ""),
    fulfillmentStatus: text(row.fulfillmentStatus),
    title: String(row.title ?? ""),
    subtitle: String(row.subtitle ?? ""),
    amount: money2(row.amount),
    points: Number(row.points ?? 0),
    network: text(row.network),
    recipient: policy.mask ? maskPhone(row.recipient) : text(row.recipient) ?? "—",
    provider: text(row.provider),
    providerReference: text(row.providerReference),
    providerStatus: text(row.providerStatus),
    charged: Boolean(chargedAt),
    chargedAt,
    fulfilledAt: iso(row.fulfilledAt),
    refundedAt: iso(row.refundedAt),
    createdAt: iso(row.createdAt) ?? "",
  };
}

// ---------------------------------------------------------------------------
// 4. Users
// ---------------------------------------------------------------------------

const USER_SORTS: Record<string, SQL> = {
  recent: sql`"u"."created_at" desc, "u"."id" desc`,
  balance: sql`coalesce("w"."balance", 0) desc, "u"."id" desc`,
  name: sql`"u"."name" asc, "u"."id" asc`,
  id: sql`"u"."id" asc`,
};

export type UserQuery = {
  search?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
};

export async function loadUsers(query: UserQuery): Promise<AdminList<AdminUserRow>> {
  return withSchemaFallback(async () => {
    const term = parseSearch(query.search);
    const pageSize = parsePageSize(query.pageSize);
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const sort = USER_SORTS[query.sort ?? ""] ?? USER_SORTS.recent;

    return withReadOnlyTx("admin.users", async (tx) => {
      const search = searchAny(term, [
        sql`"u"."name"`,
        sql`"u"."email"`,
        sql`"u"."phone"`,
        sql`"u"."referral_code"`,
      ]);
      const idMatch = /^\d+$/.test(term) ? sql`"u"."id" = ${Number(term)}` : null;
      const where = whereAll([
        search || idMatch ? sql`(${sql.join([search, idMatch].filter(Boolean) as SQL[], sql` or `)})` : null,
      ]);

      const select = sql`select
          "u"."id" as "userId", "u"."name" as "name", "u"."email" as "email", "u"."phone" as "phone",
          "u"."created_at" as "createdAt", "u"."email_verified_at" as "emailVerifiedAt",
          "u"."is_admin" as "isAdmin", "u"."referral_code" as "referralCode",
          "w"."wallet_id" as "walletId", coalesce("w"."wallet_count", 0)::int as "walletCount",
          coalesce("w"."balance", 0)::text as "balance", coalesce("w"."points", 0)::int as "points",
          coalesce("s"."active_sessions", 0)::int as "activeSessions", "s"."last_seen_at" as "lastSeenAt"
        from "users" "u"
        left join lateral (
          select min("id") as "wallet_id", count(*)::int as "wallet_count",
                 sum("balance") as "balance", sum("points") as "points"
          from "wallets" where "user_id" = "u"."id"
        ) "w" on true
        left join lateral (
          select count(*)::int as "active_sessions", max("last_seen_at") as "last_seen_at"
          from "sessions" where "user_id" = "u"."id" and "expires_at" > now()
        ) "s" on true`;

      const rows = await all<Record<string, unknown>>(
        tx,
        sql`${select} where ${where} order by ${sort} limit ${pageSize} offset ${offsetFor(page, pageSize)}`,
      );
      const total = countRows(
        await tx.execute(sql`select count(*)::int as "c" from "users" "u" where ${where}`),
      );

      return {
        rows: rows.map((row) => ({
          userId: Number(row.userId),
          name: String(row.name ?? ""),
          email: maskEmail(row.email),
          phone: maskPhone(row.phone),
          createdAt: iso(row.createdAt) ?? "",
          emailVerifiedAt: iso(row.emailVerifiedAt),
          isAdmin: Boolean(row.isAdmin),
          referralCode: text(row.referralCode),
          walletId: row.walletId === null || row.walletId === undefined ? null : Number(row.walletId),
          walletCount: Number(row.walletCount ?? 0),
          balance: money2(row.balance),
          points: Number(row.points ?? 0),
          activeSessions: Number(row.activeSessions ?? 0),
          lastSeenAt: iso(row.lastSeenAt),
        })),
        total,
        page,
        pageSize,
      };
    });
  }, "admin users");
}

export async function loadUserDetail(userId: number): Promise<AdminUserDetail | null> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);

    return withReadOnlyTx("admin.user-detail", async (tx) => {
      const row = await first<Record<string, unknown>>(
        tx,
        sql`select "id", "name", "email", "phone", "created_at", "updated_at",
                   "email_verified_at", "is_admin", "referral_code", "referred_by",
                   "referral_rewarded_at", "notify_promos", "notify_tx"
            from "users" where "id" = ${userId} limit 1`,
      );
      if (!row) return null;

      const wallets = await all<Record<string, unknown>>(
        tx,
        sql`select "id" as "walletId", "number" as "walletNumber", "balance"::text as "balance",
                   "points", "is_agent" as "isAgent", "agent_tier" as "agentTier", "created_at" as "createdAt"
            from "wallets" where "user_id" = ${userId} order by "id" asc`,
      );

      const sessions = await all<Record<string, unknown>>(
        tx,
        sql`select "id" as "sessionId", "created_at" as "createdAt", "last_seen_at" as "lastSeenAt",
                   "expires_at" as "expiresAt", "ip", "user_agent" as "userAgent"
            from "sessions" where "user_id" = ${userId}
            order by "last_seen_at" desc limit 5`,
      );

      const recentTransactions = await all<Record<string, unknown>>(
        tx,
        sql`${txColumnsSql("t", caps)}
            from "transactions" "t"
            left join "wallets" "w" on "w"."id" = "t"."wallet_id"
            left join "users" "u" on "u"."id" = "w"."user_id"
            where "w"."user_id" = ${userId}
            order by "t"."created_at" desc, "t"."id" desc limit 10`,
      );

      const totalsRow =
        (await first<Record<string, unknown>>(
          tx,
          sql`select
                count(*) filter (where "type" = 'deposit' and "status" = 'successful')::int as "deposits",
                coalesce(sum("amount") filter (where "type" = 'deposit' and "status" = 'successful'), 0)::text as "depositValue",
                count(*) filter (where "type" in ('data', 'airtime') and "status" = 'successful')::int as "purchases",
                coalesce(sum("amount") filter (where "type" in ('data', 'airtime') and "status" = 'successful'), 0)::text as "purchaseValue",
                ${
                  caps.fulfillmentStatus
                    ? sql`count(*) filter (where "type" in ('data', 'airtime') and "fulfillment_status" = 'failed')::int`
                    : sql`null::int`
                } as "failedDeliveries"
              from "transactions" "t"
              left join "wallets" "w" on "w"."id" = "t"."wallet_id"
              where "w"."user_id" = ${userId}`,
        )) ?? {};

      const orders = caps.checkoutTable
        ? await all<Record<string, unknown>>(
            tx,
            sql`select "id", "ref", "network", "plan_label" as "planLabel", "amount"::text as "amount",
                       "payment_status" as "paymentStatus", "order_status" as "orderStatus",
                       "fulfillment_status" as "fulfillmentStatus", "recipient",
                       "paid_at" as "paidAt", "created_at" as "createdAt", "updated_at" as "updatedAt"
                from "checkout_orders" where "user_id" = ${userId}
                order by "created_at" desc limit 10`,
          )
        : [];

      return {
        user: {
          userId: Number(row.id),
          name: String(row.name ?? ""),
          email: String(row.email ?? ""),
          phone: String(row.phone ?? ""),
          createdAt: iso(row.created_at) ?? "",
          updatedAt: iso(row.updated_at),
          emailVerifiedAt: iso(row.email_verified_at),
          isAdmin: Boolean(row.is_admin),
          referralCode: text(row.referral_code),
          referredBy: row.referred_by === null || row.referred_by === undefined ? null : Number(row.referred_by),
          referralRewardedAt: iso(row.referral_rewarded_at),
          notifyPromos: Boolean(row.notify_promos),
          notifyTx: Boolean(row.notify_tx),
        },
        wallets: wallets.map((wallet): AdminUserWalletRow => ({
          walletId: Number(wallet.walletId),
          walletNumber: String(wallet.walletNumber ?? ""),
          balance: money2(wallet.balance),
          points: Number(wallet.points ?? 0),
          isAgent: Boolean(wallet.isAgent),
          agentTier: text(wallet.agentTier),
          createdAt: iso(wallet.createdAt) ?? "",
        })),
        sessions: sessions.map((session): AdminUserSessionRow => ({
          sessionId: Number(session.sessionId),
          createdAt: iso(session.createdAt) ?? "",
          lastSeenAt: iso(session.lastSeenAt) ?? "",
          expiresAt: iso(session.expiresAt) ?? "",
          expired: (() => {
            const expires = iso(session.expiresAt);
            return expires ? new Date(expires).getTime() <= Date.now() : true;
          })(),
          ip: text(session.ip),
          userAgent: clampText(text(session.userAgent), 90),
        })),
        recentTransactions: recentTransactions.map((txRow) =>
          toTransactionRow(txRow, caps, { mask: false }),
        ),
        recentOrders: orders.map((order) => ({
          channel: "checkout" as const,
          id: Number(order.id),
          ref: String(order.ref ?? ""),
          userId: Number(userId),
          customerName: null,
          customerEmail: "",
          phone: String(order.recipient ?? ""),
          network: text(order.network),
          bundle: String(order.planLabel ?? ""),
          amount: money2(order.amount),
          paymentStatus: String(order.paymentStatus ?? ""),
          walletDebit: "Paid via Paystack (wallet untouched)",
          provider: null,
          providerReference: null,
          providerStatus: null,
          providerMessage: null,
          deliveryStatus: String(order.orderStatus ?? ""),
          delivery: String(order.orderStatus ?? "").replace(/_/g, " "),
          deliverySeverity: "unknown" as const,
          createdAt: iso(order.createdAt) ?? "",
          updatedAt: iso(order.updatedAt),
        })),
        totals: {
          successfulDeposits: row0(totalsRow.deposits),
          successfulDepositValue: row0(totalsRow.depositValue),
          successfulPurchases: row0(totalsRow.purchases),
          successfulPurchaseValue: row0(totalsRow.purchaseValue),
          failedDeliveries: row0(totalsRow.failedDeliveries),
        },
      } satisfies AdminUserDetail;
    });
  }, "admin user detail");
}

function row0(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return money2(value);
}

// ---------------------------------------------------------------------------
// 5. Reconciliation
// ---------------------------------------------------------------------------

export type ReconciliationQuery = {
  search?: string;
  /** Restrict the report to one wallet (used by the wallet detail screen). */
  walletId?: number | null;
  onlyMismatches?: boolean;
  page?: number;
  pageSize?: number;
};

export async function loadReconciliation(
  query: ReconciliationQuery,
): Promise<AdminReconciliationResult> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    const rule = reconciliationRule(caps);
    const term = parseSearch(query.search);
    const pageSize = parsePageSize(query.pageSize);
    const page = Math.max(1, Math.trunc(query.page ?? 1));

    return withReadOnlyTx("admin.reconciliation", async (tx) => {
      const search = searchAny(term, [
        sql`"w"."number"`,
        sql`"u"."name"`,
        sql`"u"."email"`,
        sql`"u"."phone"`,
      ]);
      const idMatch = /^\d+$/.test(term) ? sql`"w"."id" = ${Number(term)}` : null;
      const walletFilter =
        query.walletId && Number.isInteger(query.walletId) && query.walletId > 0
          ? sql`"w"."id" = ${query.walletId}`
          : null;
      const mismatch = query.onlyMismatches
        ? sql`abs(coalesce("l"."calculated", 0) - "w"."balance") > 0.005`
        : null;
      const where = whereAll([
        search || idMatch ? sql`(${sql.join([search, idMatch].filter(Boolean) as SQL[], sql` or `)})` : null,
        walletFilter,
        mismatch,
      ]);

      const rows = await all<WalletRowSql>(
        tx,
        sql`select
              "w"."id" as "walletId", "w"."name" as "walletName", "w"."number" as "walletNumber",
              "w"."balance"::text as "storedBalance", "w"."points" as "points",
              "w"."is_agent" as "isAgent", "w"."agent_tier" as "agentTier", "w"."created_at" as "createdAt",
              "u"."id" as "userId", "u"."name" as "userName", "u"."email" as "userEmail", "u"."phone" as "userPhone",
              "l"."calculated"::text as "calculated", "l"."counted" as "counted", "l"."last_at" as "last_at"
            from "wallets" "w"
            left join "users" "u" on "u"."id" = "w"."user_id"
            ${walletLedgerJoin(caps)}
            where ${where}
            order by abs(coalesce("l"."calculated", 0) - "w"."balance") desc nulls last, "w"."id" desc
            limit ${pageSize} offset ${offsetFor(page, pageSize)}`,
      );

      const total = countRows(
        await tx.execute(
          sql`select count(*)::int as "c"
              from "wallets" "w"
              left join "users" "u" on "u"."id" = "w"."user_id"
              ${walletLedgerJoin(caps)}
              where ${where}`,
        ),
      );

      const summaryRow =
        (await first<Record<string, unknown>>(
          tx,
          sql`select
                count(*)::int as "wallets",
                count(*) filter (where abs(coalesce("l"."calculated", 0) - "w"."balance") > 0.005)::int as "mismatches"
              from "wallets" "w"
              ${walletLedgerJoin(caps)}`,
        )) ?? {};

      const mapped: AdminReconciliationRow[] = rows.map((row) => {
        const stored = money2(row.storedBalance);
        const calculated = row.calculated === null ? null : money2(row.calculated);
        const verdict = classifyReconciliation({
          storedBalance: stored,
          calculatedBalance: calculated,
          examined: row.counted ?? null,
          rule,
        });
        return {
          walletId: Number(row.walletId),
          walletName: String(row.walletName ?? ""),
          walletNumber: String(row.walletNumber ?? ""),
          userId: row.userId === null ? null : Number(row.userId),
          userName: text(row.userName),
          userEmail: maskEmail(row.userEmail),
          storedBalance: stored,
          calculatedBalance: calculated,
          difference: verdict.difference,
          status: verdict.status,
          severity: verdict.severity,
          label: verdict.label,
          guidance: verdict.guidance,
          transactionsExamined: row.counted === null ? null : Number(row.counted),
          lastTransactionAt: iso(row.last_at),
        };
      });

      return {
        rows: mapped,
        total,
        page,
        pageSize,
        rule: { id: rule.id, label: rule.label, exact: rule.exact, note: rule.note },
        walletsExamined: Number(summaryRow.wallets ?? 0),
        mismatches: Number(summaryRow.mismatches ?? 0),
        notAvailable: !caps.chargedAt && !caps.refundedAt,
      } satisfies AdminReconciliationResult;
    });
  }, "admin reconciliation");
}
