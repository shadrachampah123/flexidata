import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { withSchemaFallback } from "@/lib/schema-compat";
import { withReadOnlyTx, countRows, iso, money2, type AdminExecutor } from "@/lib/admin/db";
import { maskEmail, maskPhone, clampText } from "@/lib/admin/redact";
import {
  likePattern,
  offsetFor,
  parseAmount,
  parseDateFrom,
  parseDateTo,
  parseEnum,
  parseId,
  parsePageSize,
  parseSearch,
  type AdminList,
} from "@/lib/admin/filters";
import type {
  AdminAttentionRow,
  AdminDataOrderRow,
  AdminDepositCreditState,
  AdminPaymentRow,
  AdminSeverity,
  AdminTransactionRow,
} from "@/lib/admin/types";
import { toAdminCaps, toTransactionRow, txColumnsSql, type AdminCaps } from "@/lib/admin/queries";

/**
 * Phase 1 admin read layer — transactions, data operations, the support queue
 * and payments. Same guarantees as `src/lib/admin/queries.ts`: read-only
 * transactions, bound parameters, schema-drift aware, minimum PII, no N+1.
 *
 * Nothing in this file retries a delivery, refunds a payment or writes anything.
 */

/** Per-source cap for the attention queue. Bounds the work, keeps it honest. */
export const ATTENTION_SOURCE_LIMIT = 200;

/** An order is "stuck" once it has been paid but not fulfilled for this long. */
export const STUCK_AFTER_MS = 2 * 60 * 60 * 1000;
/** A funding attempt is stale once it has sat `pending` for this long. */
export const STALE_DEPOSIT_MS = 24 * 60 * 60 * 1000;

/** `now() - interval` is spelled as a bound timestamp so the interval syntax
 *  never depends on the server's interval parsing of a parameter. */
function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// ---------------------------------------------------------------------------
// 3. Transaction explorer
// ---------------------------------------------------------------------------

export const TX_TYPES = ["data", "airtime", "conversion", "deposit", "transfer", "redemption", "referral"] as const;
export const TX_STATUSES = ["successful", "pending", "failed", "reversed"] as const;
export const TX_DIRECTIONS = ["in", "out"] as const;

const TX_SORTS: Record<string, SQL> = {
  recent: sql`"t"."created_at" desc, "t"."id" desc`,
  oldest: sql`"t"."created_at" asc, "t"."id" asc`,
  amount: sql`"t"."amount" desc, "t"."id" desc`,
  id: sql`"t"."id" desc`,
};

export type TransactionQuery = {
  search?: string;
  walletId?: number | null;
  userId?: number | null;
  type?: string | null;
  status?: string | null;
  direction?: string | null;
  provider?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  sort?: string | null;
  page?: number;
  pageSize?: number;
};

function txWhere(query: TransactionQuery, caps: AdminCaps): SQL {
  const term = parseSearch(query.search);
  const parts: Array<SQL | null> = [
    term
      ? sql`(${sql.join(
          [
            sql`coalesce("t"."ref", '') ilike ${likePattern(term)}`,
            sql`coalesce("t"."title", '') ilike ${likePattern(term)}`,
            sql`coalesce("t"."subtitle", '') ilike ${likePattern(term)}`,
            sql`coalesce("t"."recipient", '') ilike ${likePattern(term)}`,
            sql`coalesce("u"."name", '') ilike ${likePattern(term)}`,
            sql`coalesce("u"."email", '') ilike ${likePattern(term)}`,
            sql`coalesce("u"."phone", '') ilike ${likePattern(term)}`,
          ],
          sql` or `,
        )})`
      : null,
    query.walletId ? sql`"t"."wallet_id" = ${query.walletId}` : null,
    query.userId ? sql`"w"."user_id" = ${query.userId}` : null,
    query.type ? sql`"t"."type" = ${query.type}` : null,
    query.status ? sql`"t"."status" = ${query.status}` : null,
    query.direction ? sql`"t"."direction" = ${query.direction}` : null,
    query.provider && caps.provider ? sql`"t"."provider" = ${query.provider}` : null,
    query.dateFrom ? sql`"t"."created_at" >= ${query.dateFrom}` : null,
    query.dateTo ? sql`"t"."created_at" <= ${query.dateTo}` : null,
    query.amountMin !== null && query.amountMin !== undefined
      ? sql`"t"."amount" >= ${query.amountMin}`
      : null,
    query.amountMax !== null && query.amountMax !== undefined
      ? sql`"t"."amount" <= ${query.amountMax}`
      : null,
  ];
  const active = parts.filter((part): part is SQL => part !== null);
  return active.length === 0 ? sql`true` : sql`${sql.join(active, sql` and `)}`;
}

function normalizeTransactionQuery(query: TransactionQuery): TransactionQuery {
  return {
    ...query,
    search: parseSearch(query.search),
    walletId: parseId(query.walletId),
    userId: parseId(query.userId),
    type: parseEnum(query.type, TX_TYPES),
    status: parseEnum(query.status, TX_STATUSES),
    direction: parseEnum(query.direction, TX_DIRECTIONS),
    provider: query.provider ? query.provider.slice(0, 40) : null,
    dateFrom: parseDateFrom(query.dateFrom),
    dateTo: parseDateTo(query.dateTo),
    amountMin: parseAmount(query.amountMin),
    amountMax: parseAmount(query.amountMax),
  };
}

export async function loadTransactions(
  input: TransactionQuery,
): Promise<AdminList<AdminTransactionRow> & { providers: string[] }> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    const query = normalizeTransactionQuery(input);
    const pageSize = parsePageSize(query.pageSize);
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const sort = TX_SORTS[query.sort ?? ""] ?? TX_SORTS.recent;
    const where = txWhere(query, caps);

    return withReadOnlyTx("admin.transactions", async (tx) => {
      const rows = await all<Record<string, unknown>>(
        tx,
        sql`${txColumnsSql("t", caps)}
            from "transactions" "t"
            left join "wallets" "w" on "w"."id" = "t"."wallet_id"
            left join "users" "u" on "u"."id" = "w"."user_id"
            where ${where}
            order by ${sort}
            limit ${pageSize} offset ${offsetFor(page, pageSize)}`,
      );
      const total = countRows(
        await tx.execute(
          sql`select count(*)::int as "c"
              from "transactions" "t"
              left join "wallets" "w" on "w"."id" = "t"."wallet_id"
              left join "users" "u" on "u"."id" = "w"."user_id"
              where ${where}`,
        ),
      );
      const providers = caps.provider
        ? (
            await all<{ provider: string | null }>(
              tx,
              sql`select distinct "t"."provider" as "provider" from "transactions" "t"
                  where "t"."provider" is not null order by "t"."provider" asc limit 50`,
            )
          )
            .map((row) => String(row.provider))
            .filter(Boolean)
        : [];

      return {
        rows: rows.map((row) => toTransactionRow(row, caps, { mask: true })),
        total,
        page,
        pageSize,
        providers,
      };
    });
  }, "admin transactions");
}

/** One transaction, unmasked — a deliberately opened single record. */
export async function loadTransactionDetail(
  ref: string,
): Promise<AdminTransactionRow | null> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    return withReadOnlyTx("admin.transaction-detail", async (tx) => {
      const row = await firstRow(
        tx,
        sql`${txColumnsSql("t", caps)}
            from "transactions" "t"
            left join "wallets" "w" on "w"."id" = "t"."wallet_id"
            left join "users" "u" on "u"."id" = "w"."user_id"
            where "t"."ref" = ${ref}
            limit 1`,
      );
      return row ? toTransactionRow(row, caps, { mask: false }) : null;
    });
  }, "admin transaction detail");
}

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

// ---------------------------------------------------------------------------
// 4. Data operations
// ---------------------------------------------------------------------------

export type DataChannel = "wallet" | "checkout";

/**
 * Delivery buckets. Both channels are bucketed with their own columns because
 * they genuinely differ: wallet purchases carry `fulfillment_status` on the
 * ledger, checkout orders carry `order_status`/`payment_status`.
 */
export const DELIVERY_BUCKETS = [
  "successful",
  "processing",
  "pending",
  "failed",
  "refunded",
  "cancelled",
  "attention",
] as const;

export type DeliveryBucket = (typeof DELIVERY_BUCKETS)[number];

function bucketCondition(bucket: DeliveryBucket, caps: AdminCaps): SQL | null {
  if (bucket === "successful") {
    return caps.fulfillmentStatus
      ? sql`("t"."status" = 'successful' and ("t"."fulfillment_status" = 'delivered' or "t"."fulfillment_status" is null))`
      : sql`("t"."status" = 'successful')`;
  }
  if (bucket === "processing") {
    return caps.fulfillmentStatus
      ? sql`("t"."fulfillment_status" in ('submitted', 'processing'))`
      : sql`("t"."status" = 'pending')`;
  }
  if (bucket === "pending") return sql`("t"."status" = 'pending')`;
  if (bucket === "failed") {
    return caps.fulfillmentStatus
      ? sql`("t"."status" = 'failed' or "t"."fulfillment_status" = 'failed')`
      : sql`("t"."status" = 'failed')`;
  }
  if (bucket === "refunded") {
    const reversed = caps.reversedStatus ? sql`"t"."status" = 'reversed' or ` : sql``;
    return caps.refundedAt
      ? sql`(${reversed}"t"."refunded_at" is not null)`
      : caps.reversedStatus
        ? sql`("t"."status" = 'reversed')`
        : null;
  }
  if (bucket === "cancelled") return sql`false`;
  if (bucket === "attention") {
    // Money actually taken, nothing delivered, no refund recorded, and either
    // the provider has failed it or it has been unfinished for longer than the
    // stuck-order window. An in-flight order is normal traffic, not a finding.
    const notRefunded = caps.refundedAt ? sql`"t"."refunded_at" is null` : sql`true`;
    const tookMoney = caps.chargedAt ? sql`"t"."charged_at" is not null` : sql`true`;
    const failedState = caps.fulfillmentStatus
      ? sql`("t"."status" in ('pending', 'failed') or "t"."fulfillment_status" = 'failed')`
      : sql`("t"."status" in ('pending', 'failed'))`;
    const unresolved = caps.fulfillmentStatus
      ? sql`("t"."fulfillment_status" = 'failed' or "t"."created_at" < ${agoIso(STUCK_AFTER_MS)}::timestamptz)`
      : sql`true`;
    return sql`(${notRefunded} and ${tookMoney} and ${failedState} and ${unresolved})`;
  }
  return null;
}

function checkoutBucketCondition(bucket: DeliveryBucket): SQL | null {
  switch (bucket) {
    case "successful":
      return sql`("o"."order_status" = 'fulfilled')`;
    case "processing":
      return sql`("o"."order_status" in ('paid', 'fulfilling'))`;
    case "pending":
      return sql`("o"."order_status" = 'awaiting_payment')`;
    case "failed":
      return sql`("o"."order_status" = 'payment_failed')`;
    case "cancelled":
      return sql`("o"."order_status" = 'abandoned')`;
    case "refunded":
      // No refund concept exists on checkout_orders: nothing is ever reported
      // here rather than something being guessed.
      return sql`false`;
    case "attention":
      return sql`("o"."order_status" = 'fulfillment_failed'
                  or ("o"."order_status" in ('paid', 'fulfilling')
                      and "o"."updated_at" < ${agoIso(STUCK_AFTER_MS)}::timestamptz))`;
    default:
      return null;
  }
}

export type DataOrderQuery = {
  channel?: DataChannel;
  search?: string;
  bucket?: DeliveryBucket | null;
  network?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  page?: number;
  pageSize?: number;
};

function normalizeDataQuery(query: DataOrderQuery): DataOrderQuery {
  return {
    ...query,
    channel: query.channel === "checkout" ? "checkout" : "wallet",
    search: parseSearch(query.search),
    bucket: parseEnum(query.bucket, DELIVERY_BUCKETS),
    network: parseEnum(query.network, ["MTN", "TELECEL"] as const),
    dateFrom: parseDateFrom(query.dateFrom),
    dateTo: parseDateTo(query.dateTo),
    amountMin: parseAmount(query.amountMin),
    amountMax: parseAmount(query.amountMax),
  };
}

function dataWhere(query: DataOrderQuery, caps: AdminCaps): SQL {
  const term = query.search ?? "";
  const parts: Array<SQL | null> = [
    term
      ? sql`(${sql.join(
          [
            sql`coalesce("t"."ref", '') ilike ${likePattern(term)}`,
            sql`coalesce("t"."recipient", '') ilike ${likePattern(term)}`,
            sql`coalesce("t"."title", '') ilike ${likePattern(term)}`,
            sql`coalesce("u"."name", '') ilike ${likePattern(term)}`,
            sql`coalesce("u"."email", '') ilike ${likePattern(term)}`,
          ],
          sql` or `,
        )})`
      : null,
    sql`"t"."type" in ('data', 'airtime')`,
    query.network ? sql`"t"."network" = ${query.network}` : null,
    query.dateFrom ? sql`"t"."created_at" >= ${query.dateFrom}` : null,
    query.dateTo ? sql`"t"."created_at" <= ${query.dateTo}` : null,
    query.amountMin !== null && query.amountMin !== undefined
      ? sql`"t"."amount" >= ${query.amountMin}`
      : null,
    query.amountMax !== null && query.amountMax !== undefined
      ? sql`"t"."amount" <= ${query.amountMax}`
      : null,
    query.bucket ? bucketCondition(query.bucket, caps) : null,
  ];
  const active = parts.filter((part): part is SQL => part !== null);
  return active.length === 0 ? sql`true` : sql`${sql.join(active, sql` and `)}`;
}

function checkoutWhere(query: DataOrderQuery): SQL {
  const term = query.search ?? "";
  const parts: Array<SQL | null> = [
    term
      ? sql`(${sql.join(
          [
            sql`coalesce("o"."ref", '') ilike ${likePattern(term)}`,
            sql`coalesce("o"."recipient", '') ilike ${likePattern(term)}`,
            sql`coalesce("o"."plan_label", '') ilike ${likePattern(term)}`,
            sql`coalesce("o"."customer_email", '') ilike ${likePattern(term)}`,
            sql`coalesce("u"."name", '') ilike ${likePattern(term)}`,
          ],
          sql` or `,
        )})`
      : null,
    query.network ? sql`"o"."network" = ${query.network}` : null,
    query.dateFrom ? sql`"o"."created_at" >= ${query.dateFrom}` : null,
    query.dateTo ? sql`"o"."created_at" <= ${query.dateTo}` : null,
    query.amountMin !== null && query.amountMin !== undefined
      ? sql`"o"."amount" >= ${query.amountMin}`
      : null,
    query.amountMax !== null && query.amountMax !== undefined
      ? sql`"o"."amount" <= ${query.amountMax}`
      : null,
    query.bucket ? checkoutBucketCondition(query.bucket) : null,
  ];
  const active = parts.filter((part): part is SQL => part !== null);
  return active.length === 0 ? sql`true` : sql`${sql.join(active, sql` and `)}`;
}

function deliveryLabel(status: string | null, fulfillment: string | null): {
  delivery: string;
  severity: AdminSeverity;
} {
  if (fulfillment === "delivered" || (status === "successful" && !fulfillment)) {
    return { delivery: "Delivered", severity: "healthy" };
  }
  if (fulfillment === "failed" || status === "failed") return { delivery: "Failed", severity: "critical" };
  if (status === "reversed" || fulfillment === "refunded") {
    return { delivery: "Refunded / reversed", severity: "unknown" };
  }
  if (fulfillment === "processing" || fulfillment === "submitted") {
    return { delivery: "Processing", severity: "attention" };
  }
  if (status === "pending") return { delivery: "Pending", severity: "attention" };
  return { delivery: fulfillment ?? status ?? "Unknown", severity: "unknown" };
}

function checkoutDeliveryLabel(orderStatus: string): { delivery: string; severity: AdminSeverity } {
  switch (orderStatus) {
    case "fulfilled":
      return { delivery: "Delivered", severity: "healthy" };
    case "fulfilling":
      return { delivery: "Fulfilling", severity: "attention" };
    case "paid":
      return { delivery: "Paid — sending to network", severity: "attention" };
    case "awaiting_payment":
      return { delivery: "Awaiting payment", severity: "attention" };
    case "payment_failed":
      return { delivery: "Payment failed", severity: "critical" };
    case "abandoned":
      return { delivery: "Cancelled / abandoned", severity: "unknown" };
    case "fulfillment_failed":
      return { delivery: "Fulfilment failed — support", severity: "critical" };
    default:
      return { delivery: orderStatus, severity: "unknown" };
  }
}

function walletDebitLabel(row: {
  chargedAt: string | null;
  refundedAt: string | null;
  status: string;
}): string {
  if (row.chargedAt && row.refundedAt) return "Refunded to wallet";
  if (row.chargedAt) return "Debited";
  if (row.refundedAt) return "Refunded to wallet";
  if (row.status === "failed") return "Not charged";
  if (row.status === "reversed") return "Reversed";
  return "Not debited";
}

export async function loadDataOrders(
  input: DataOrderQuery,
): Promise<
  AdminList<AdminDataOrderRow> & {
    buckets: Record<DeliveryBucket, number | null>;
    channel: DataChannel;
  }
> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    const query = normalizeDataQuery(input);
    const pageSize = parsePageSize(query.pageSize);
    const page = Math.max(1, Math.trunc(query.page ?? 1));

    return withReadOnlyTx("admin.data", async (tx) => {
      if (query.channel === "checkout") {
        if (!caps.checkoutTable) {
          return {
            rows: [],
            total: 0,
            page,
            pageSize,
            channel: "checkout" as const,
            buckets: emptyBuckets(),
          };
        }
        const where = checkoutWhere(query);
        const rows = await all<Record<string, unknown>>(
          tx,
          sql`select "o"."id" as "id", "o"."ref" as "ref", "o"."user_id" as "userId",
                     "o"."customer_email" as "customerEmail", "o"."recipient" as "recipient",
                     "o"."network" as "network", "o"."plan_label" as "bundle",
                     "o"."amount"::text as "amount",
                     "o"."payment_status" as "paymentStatus", "o"."order_status" as "orderStatus",
                     "o"."fulfillment_status" as "fulfillmentStatus",
                     "o"."provider_reference" as "providerReference",
                     "o"."provider_status" as "providerStatus",
                     "o"."provider_message" as "providerMessage",
                     "o"."created_at" as "createdAt", "o"."updated_at" as "updatedAt",
                     "u"."name" as "userName"
              from "checkout_orders" "o"
              left join "users" "u" on "u"."id" = "o"."user_id"
              where ${where}
              order by "o"."created_at" desc, "o"."id" desc
              limit ${pageSize} offset ${offsetFor(page, pageSize)}`,
        );
        const total = countRows(
          await tx.execute(
            sql`select count(*)::int as "c" from "checkout_orders" "o"
                left join "users" "u" on "u"."id" = "o"."user_id" where ${where}`,
          ),
        );
        const buckets = await countCheckoutBuckets(tx);
        return {
          rows: rows.map((row) => mapCheckoutOrder(row)),
          total,
          page,
          pageSize,
          channel: "checkout" as const,
          buckets,
        };
      }

      const where = dataWhere(query, caps);
      const rows = await all<Record<string, unknown>>(
        tx,
        sql`select "t"."id" as "id", "t"."ref" as "ref", "t"."wallet_id" as "walletId",
                   "t"."type" as "type", "t"."status" as "status", "t"."title" as "title",
                   "t"."amount"::text as "amount", "t"."network" as "network",
                   "t"."recipient" as "recipient", "t"."created_at" as "createdAt",
                   ${
                     caps.fulfillmentStatus
                       ? sql`"t"."fulfillment_status" as "fulfillmentStatus"`
                       : sql`null::text as "fulfillmentStatus"`
                   },
                   ${
                     caps.provider ? sql`"t"."provider" as "provider"` : sql`null::text as "provider"`
                   },
                   ${
                     caps.providerReference
                       ? sql`"t"."provider_reference" as "providerReference"`
                       : sql`null::text as "providerReference"`
                   },
                   ${
                     caps.providerStatus
                       ? sql`"t"."provider_status" as "providerStatus"`
                       : sql`null::text as "providerStatus"`
                   },
                   ${
                     caps.providerMessage
                       ? sql`"t"."provider_message" as "providerMessage"`
                       : sql`null::text as "providerMessage"`
                   },
                   ${caps.chargedAt ? sql`"t"."charged_at" as "chargedAt"` : sql`null::text as "chargedAt"`},
                   ${
                     caps.refundedAt
                       ? sql`"t"."refunded_at" as "refundedAt"`
                       : sql`null::text as "refundedAt"`
                   },
                   ${
                     caps.lastProviderSyncAt
                       ? sql`"t"."last_provider_sync_at" as "syncedAt"`
                       : sql`null::text as "syncedAt"`
                   },
                   "u"."id" as "userId", "u"."name" as "userName", "u"."email" as "userEmail"
            from "transactions" "t"
            left join "wallets" "w" on "w"."id" = "t"."wallet_id"
            left join "users" "u" on "u"."id" = "w"."user_id"
            where ${where}
            order by "t"."created_at" desc, "t"."id" desc
            limit ${pageSize} offset ${offsetFor(page, pageSize)}`,
      );
      const total = countRows(
        await tx.execute(
          sql`select count(*)::int as "c"
              from "transactions" "t"
              left join "wallets" "w" on "w"."id" = "t"."wallet_id"
              left join "users" "u" on "u"."id" = "w"."user_id"
              where ${where}`,
        ),
      );
      const buckets = await countWalletBuckets(tx, caps);
      return {
        rows: rows.map((row) => mapWalletOrder(row, caps)),
        total,
        page,
        pageSize,
        channel: "wallet" as const,
        buckets,
      };
    });
  }, "admin data orders");
}

function emptyBuckets(): Record<DeliveryBucket, number | null> {
  return {
    successful: null,
    processing: null,
    pending: null,
    failed: null,
    refunded: null,
    cancelled: null,
    attention: null,
  };
}

async function countWalletBuckets(
  tx: AdminExecutor,
  caps: AdminCaps,
): Promise<Record<DeliveryBucket, number | null>> {
  const columns: SQL[] = [];
  for (const bucket of DELIVERY_BUCKETS) {
    const condition = bucketCondition(bucket, caps);
    columns.push(
      condition
        ? sql`count(*) filter (where ${condition})::int as ${sql.raw(`"${bucket}"`)}`
        : sql`null::int as ${sql.raw(`"${bucket}"`)}`,
    );
  }
  const row =
    (await firstRow(
      tx,
      sql`select ${sql.join(columns, sql`, `)} from "transactions" "t" where "t"."type" in ('data', 'airtime')`,
    )) ?? {};
  return {
    successful: optionalInt(row.successful),
    processing: optionalInt(row.processing),
    pending: optionalInt(row.pending),
    failed: optionalInt(row.failed),
    refunded: optionalInt(row.refunded),
    cancelled: optionalInt(row.cancelled),
    attention: optionalInt(row.attention),
  };
}

async function countCheckoutBuckets(tx: AdminExecutor): Promise<Record<DeliveryBucket, number | null>> {
  const columns: SQL[] = DELIVERY_BUCKETS.map((bucket) => {
    const condition = checkoutBucketCondition(bucket);
    return condition
      ? sql`count(*) filter (where ${condition})::int as ${sql.raw(`"${bucket}"`)}`
      : sql`null::int as ${sql.raw(`"${bucket}"`)}`;
  });
  const row = (await firstRow(tx, sql`select ${sql.join(columns, sql`, `)} from "checkout_orders" "o"`)) ?? {};
  return {
    successful: optionalInt(row.successful),
    processing: optionalInt(row.processing),
    pending: optionalInt(row.pending),
    failed: optionalInt(row.failed),
    refunded: optionalInt(row.refunded),
    cancelled: optionalInt(row.cancelled),
    attention: optionalInt(row.attention),
  };
}

function optionalInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function mapWalletOrder(row: Record<string, unknown>, caps: AdminCaps): AdminDataOrderRow {
  const chargedAt = iso(row.chargedAt);
  const refundedAt = iso(row.refundedAt);
  const status = String(row.status ?? "");
  const fulfillment = row.fulfillmentStatus ? String(row.fulfillmentStatus) : null;
  const label = deliveryLabel(status, fulfillment);
  return {
    channel: "wallet",
    id: Number(row.id),
    ref: String(row.ref ?? ""),
    userId: row.userId === null || row.userId === undefined ? null : Number(row.userId),
    customerName: row.userName ? String(row.userName) : null,
    customerEmail: maskEmail(row.userEmail),
    phone: maskPhone(row.recipient),
    network: row.network ? String(row.network) : null,
    bundle: String(row.title ?? ""),
    amount: money2(row.amount),
    paymentStatus: status,
    walletDebit: walletDebitLabel({ chargedAt, refundedAt, status }),
    provider: row.provider ? String(row.provider) : null,
    providerReference: row.providerReference ? String(row.providerReference) : null,
    providerStatus: row.providerStatus ? String(row.providerStatus) : null,
    providerMessage: clampText(row.providerMessage ? String(row.providerMessage) : null, 90),
    deliveryStatus: fulfillment,
    delivery: label.delivery,
    deliverySeverity: label.severity,
    createdAt: iso(row.createdAt) ?? "",
    // The ledger has no updated_at column: the last provider sync is the
    // closest existing "last touched" signal, and is null when the gateway
    // columns are missing rather than guessed from created_at.
    updatedAt: iso(row.syncedAt),
  };
}

function mapCheckoutOrder(row: Record<string, unknown>): AdminDataOrderRow {
  const orderStatus = String(row.orderStatus ?? "");
  const label = checkoutDeliveryLabel(orderStatus);
  return {
    channel: "checkout",
    id: Number(row.id),
    ref: String(row.ref ?? ""),
    userId: row.userId === null || row.userId === undefined ? null : Number(row.userId),
    customerName: row.userName ? String(row.userName) : null,
    customerEmail: maskEmail(row.customerEmail),
    phone: maskPhone(row.recipient),
    network: row.network ? String(row.network) : null,
    bundle: String(row.bundle ?? ""),
    amount: money2(row.amount),
    paymentStatus: String(row.paymentStatus ?? ""),
    walletDebit: "Paid via Paystack (wallet untouched)",
    provider: "paystack",
    providerReference: row.providerReference ? String(row.providerReference) : null,
    providerStatus: row.providerStatus ? String(row.providerStatus) : null,
    providerMessage: clampText(row.providerMessage ? String(row.providerMessage) : null, 90),
    deliveryStatus: orderStatus,
    delivery: label.delivery,
    deliverySeverity: label.severity,
    createdAt: iso(row.createdAt) ?? "",
    updatedAt: iso(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// 5. Orders requiring support (the checkout.ts:541 queue and friends)
// ---------------------------------------------------------------------------

export type AttentionQuery = {
  source?: AdminAttentionSource | null;
  search?: string;
  page?: number;
  pageSize?: number;
};

export type AdminAttentionSource = "checkout" | "wallet" | "deposit";

function checkoutReason(orderStatus: string, paymentStatus: string, message: string | null): string {
  if (orderStatus === "fulfillment_failed") {
    return (
      message ??
      "Payment confirmed but the data provider could not be reached. Support will fulfil or refund this order."
    );
  }
  if (orderStatus === "paid" || orderStatus === "fulfilling") {
    return "Paid but still not fulfilled: the order has been in flight longer than expected.";
  }
  if (paymentStatus === "failed" || orderStatus === "payment_failed") {
    return message ?? "Payment was not completed at the provider.";
  }
  return message ?? orderStatus;
}

/**
 * The operational queue: paid-but-not-delivered orders, deposits parked by the
 * Paystack verification mismatch guard, and wallet orders that were charged but
 * never delivered.
 *
 * Three bounded queries are merged here rather than in one UNION so each source
 * keeps its own schema guards. The cap ({@link ATTENTION_SOURCE_LIMIT}) is
 * surfaced in the UI — the queue is a work list, not an export.
 */
export async function loadAttention(
  input: AttentionQuery,
): Promise<
  AdminList<AdminAttentionRow> & {
    counts: { checkout: number | null; wallet: number | null; deposit: number | null };
    capped: boolean;
  }
> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    const term = parseSearch(input.search);
    const pageSize = parsePageSize(input.pageSize);
    const page = Math.max(1, Math.trunc(input.page ?? 1));

    return withReadOnlyTx("admin.attention", async (tx) => {
      const rows: AdminAttentionRow[] = [];
      let capped = false;
      const counts: { checkout: number | null; wallet: number | null; deposit: number | null } = {
        checkout: null,
        wallet: null,
        deposit: null,
      };

      if (caps.checkoutTable && input.source !== "wallet" && input.source !== "deposit") {
        const where = term
          ? sql`(${sql.join(
              [
                sql`coalesce("o"."ref", '') ilike ${likePattern(term)}`,
                sql`coalesce("o"."recipient", '') ilike ${likePattern(term)}`,
                sql`coalesce("o"."plan_label", '') ilike ${likePattern(term)}`,
                sql`coalesce("o"."customer_email", '') ilike ${likePattern(term)}`,
                sql`coalesce("u"."name", '') ilike ${likePattern(term)}`,
              ],
              sql` or `,
            )})`
          : sql`true`;
        const checkoutQueue = sql`(
                  "o"."order_status" = 'fulfillment_failed'
                  or "o"."payment_status" = 'failed'
                  or ("o"."order_status" in ('paid', 'fulfilling')
                      and "o"."updated_at" < ${agoIso(STUCK_AFTER_MS)}::timestamptz)
                )`;
        const found = await all<Record<string, unknown>>(
          tx,
          sql`select "o"."id" as "id", "o"."ref" as "ref", "o"."recipient" as "recipient",
                     "o"."customer_email" as "customerEmail", "o"."plan_label" as "bundle",
                     "o"."amount"::text as "amount", "o"."order_status" as "orderStatus",
                     "o"."payment_status" as "paymentStatus",
                     "o"."provider_message" as "providerMessage",
                     "o"."paystack_gateway_response" as "gatewayResponse",
                     "o"."created_at" as "createdAt", "o"."updated_at" as "updatedAt",
                     "u"."name" as "userName"
              from "checkout_orders" "o"
              left join "users" "u" on "u"."id" = "o"."user_id"
              where (${where}) and ${checkoutQueue}
              order by "o"."created_at" asc
              limit ${ATTENTION_SOURCE_LIMIT}`,
        );
        capped = capped || found.length >= ATTENTION_SOURCE_LIMIT;
        counts.checkout = countRows(
          await tx.execute(
            sql`select count(*)::int as "c" from "checkout_orders" "o"
                left join "users" "u" on "u"."id" = "o"."user_id"
                where (${where}) and ${checkoutQueue}`,
          ),
        );
        for (const row of found) {
          const orderStatus = String(row.orderStatus ?? "");
          const paymentStatus = String(row.paymentStatus ?? "");
          const critical = orderStatus === "fulfillment_failed" || orderStatus === "fulfilling" || orderStatus === "paid";
          rows.push({
            source: "checkout",
            id: Number(row.id),
            ref: String(row.ref ?? ""),
            customerName: row.userName ? String(row.userName) : null,
            customerEmail: maskEmail(row.customerEmail),
            phone: maskPhone(row.recipient),
            amount: money2(row.amount),
            bundle: String(row.bundle ?? ""),
            status: orderStatus,
            reason: checkoutReason(
              orderStatus,
              paymentStatus,
              clampText(row.providerMessage ? String(row.providerMessage) : null, 160) ??
                clampText(row.gatewayResponse ? String(row.gatewayResponse) : null, 160),
            ),
            severity: critical ? "critical" : "attention",
            createdAt: iso(row.createdAt) ?? "",
            updatedAt: iso(row.updatedAt),
          });
        }
      }

      if (caps.chargedAt && input.source !== "checkout" && input.source !== "deposit") {
        const where = term
          ? sql`(${sql.join(
              [
                sql`coalesce("t"."ref", '') ilike ${likePattern(term)}`,
                sql`coalesce("t"."recipient", '') ilike ${likePattern(term)}`,
                sql`coalesce("u"."name", '') ilike ${likePattern(term)}`,
                sql`coalesce("u"."email", '') ilike ${likePattern(term)}`,
              ],
              sql` or `,
            )})`
          : sql`true`;
        const notRefunded = caps.refundedAt ? sql`"t"."refunded_at" is null` : sql`true`;
        const failedState = caps.fulfillmentStatus
          ? sql`("t"."status" in ('pending', 'failed') or "t"."fulfillment_status" = 'failed')`
          : sql`("t"."status" in ('pending', 'failed'))`;
        // A charged order that is merely in flight is normal, not a finding:
        // only surface it once the provider has failed it or it has been sitting
        // unfinished for longer than the stuck-order window.
        const walletQueue = caps.fulfillmentStatus
          ? sql`(${failedState} and ("t"."fulfillment_status" = 'failed' or "t"."created_at" < ${agoIso(STUCK_AFTER_MS)}::timestamptz))`
          : sql`(${failedState} and "t"."created_at" < ${agoIso(STUCK_AFTER_MS)}::timestamptz)`;
        const found = await all<Record<string, unknown>>(
          tx,
          sql`select "t"."id" as "id", "t"."ref" as "ref", "t"."recipient" as "recipient",
                     "t"."title" as "bundle", "t"."amount"::text as "amount",
                     "t"."status" as "status", "t"."created_at" as "createdAt",
                     ${caps.refundedAt ? sql`"t"."refunded_at" as "refundedAt"` : sql`null::text as "refundedAt"`},
                     ${
                       caps.fulfillmentStatus
                         ? sql`"t"."fulfillment_status" as "fulfillmentStatus"`
                         : sql`null::text as "fulfillmentStatus"`
                     },
                     ${
                       caps.providerMessage
                         ? sql`"t"."provider_message" as "providerMessage"`
                         : sql`null::text as "providerMessage"`
                     },
                     "u"."name" as "userName", "u"."email" as "userEmail"
              from "transactions" "t"
              left join "wallets" "w" on "w"."id" = "t"."wallet_id"
              left join "users" "u" on "u"."id" = "w"."user_id"
              where (${where})
                and "t"."type" in ('data', 'airtime')
                and "t"."charged_at" is not null
                and ${notRefunded}
                and ${walletQueue}
              order by "t"."created_at" asc
              limit ${ATTENTION_SOURCE_LIMIT}`,
        );
        capped = capped || found.length >= ATTENTION_SOURCE_LIMIT;
        counts.wallet = countRows(
          await tx.execute(
            sql`select count(*)::int as "c"
                from "transactions" "t"
                left join "wallets" "w" on "w"."id" = "t"."wallet_id"
                left join "users" "u" on "u"."id" = "w"."user_id"
                where (${where})
                  and "t"."type" in ('data', 'airtime')
                  and "t"."charged_at" is not null
                  and ${notRefunded}
                  and ${walletQueue}`,
          ),
        );
        for (const row of found) {
          const refunded = Boolean(iso(row.refundedAt));
          rows.push({
            source: "wallet",
            id: Number(row.id),
            ref: String(row.ref ?? ""),
            customerName: row.userName ? String(row.userName) : null,
            customerEmail: maskEmail(row.userEmail),
            phone: maskPhone(row.recipient),
            amount: money2(row.amount),
            bundle: String(row.bundle ?? ""),
            status: String(row.status ?? ""),
            reason: refunded
              ? "Wallet was charged and later refunded, but the order never completed."
              : "Wallet debit recorded but the bundle was never delivered and no refund is recorded.",
            severity: refunded ? "attention" : "critical",
            createdAt: iso(row.createdAt) ?? "",
            updatedAt: iso(row.refundedAt),
          });
        }
      }

      if (input.source !== "checkout" && input.source !== "wallet") {
        const where = term
          ? sql`(${sql.join(
              [
                sql`coalesce("d"."ref", '') ilike ${likePattern(term)}`,
                sql`coalesce("d"."paystack_transaction_id", '') ilike ${likePattern(term)}`,
                sql`coalesce("u"."name", '') ilike ${likePattern(term)}`,
                sql`coalesce("u"."email", '') ilike ${likePattern(term)}`,
              ],
              sql` or `,
            )})`
          : sql`true`;
        const depositQueue = sql`(("d"."status" = 'failed' and "d"."provider" = 'paystack')
                  or ("d"."status" = 'pending'
                      and "d"."initiated_at" < ${agoIso(STALE_DEPOSIT_MS)}::timestamptz))`;
        const found = await all<Record<string, unknown>>(
          tx,
          sql`select "d"."id" as "id", "d"."ref" as "ref", "d"."amount"::text as "amount",
                     "d"."status" as "status", "d"."provider" as "provider", "d"."method" as "method",
                     "d"."paystack_gateway_response" as "gatewayResponse",
                     "d"."paystack_transaction_id" as "transactionId",
                     "d"."initiated_at" as "initiatedAt", "d"."updated_at" as "updatedAt",
                     "u"."name" as "userName", "u"."email" as "userEmail"
              from "deposit_requests" "d"
              left join "wallets" "w" on "w"."id" = "d"."wallet_id"
              left join "users" "u" on "u"."id" = "w"."user_id"
              where (${where}) and ${depositQueue}
              order by "d"."initiated_at" asc
              limit ${ATTENTION_SOURCE_LIMIT}`,
        );
        capped = capped || found.length >= ATTENTION_SOURCE_LIMIT;
        counts.deposit = countRows(
          await tx.execute(
            sql`select count(*)::int as "c"
                from "deposit_requests" "d"
                left join "wallets" "w" on "w"."id" = "d"."wallet_id"
                left join "users" "u" on "u"."id" = "w"."user_id"
                where (${where}) and ${depositQueue}`,
          ),
        );
        for (const row of found) {
          const status = String(row.status ?? "");
          const stuck = status === "pending";
          rows.push({
            source: "deposit",
            id: Number(row.id),
            ref: String(row.ref ?? ""),
            customerName: row.userName ? String(row.userName) : null,
            customerEmail: maskEmail(row.userEmail),
            phone: "—",
            amount: money2(row.amount),
            bundle: `Wallet top-up (${String(row.method ?? "card")})`,
            status,
            reason: stuck
              ? "Funding attempt left pending for more than 24 hours without confirmation."
              : clampText(row.gatewayResponse ? String(row.gatewayResponse) : null, 160) ??
                "Deposit failed at the provider and was not credited.",
            severity: stuck ? "attention" : "critical",
            createdAt: iso(row.initiatedAt) ?? "",
            updatedAt: iso(row.updatedAt),
          });
        }
      }

      const rank: Record<AdminSeverity, number> = { critical: 0, attention: 1, healthy: 2, unknown: 3 };
      rows.sort(
        (a, b) =>
          rank[a.severity] - rank[b.severity] ||
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

      const start = (page - 1) * pageSize;
      return {
        rows: rows.slice(start, start + pageSize),
        total: rows.length,
        page,
        pageSize,
        counts,
        capped,
      };
    });
  }, "admin attention");
}

// ---------------------------------------------------------------------------
// 6. Payments / deposits
// ---------------------------------------------------------------------------

export const DEPOSIT_STATUSES = ["pending", "successful", "failed", "abandoned"] as const;

export type PaymentQuery = {
  search?: string;
  sort?: string | null;
  status?: string | null;
  provider?: string | null;
  channel?: string | null;
  walletId?: number | null;
  userId?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  credit?: string | null;
  page?: number;
  pageSize?: number;
};

const PAYMENT_SORTS: Record<string, SQL> = {
  recent: sql`"p"."initiatedAt" desc, "p"."id" desc`,
  oldest: sql`"p"."initiatedAt" asc, "p"."id" asc`,
  amount: sql`"p"."amount" desc, "p"."id" desc`,
};

function paymentWhere(query: PaymentQuery, caps: AdminCaps): { where: SQL; having: SQL | null } {
  const term = query.search ?? "";
  const parts: Array<SQL | null> = [
    term
      ? sql`(${sql.join(
          [
            sql`coalesce("d"."ref", '') ilike ${likePattern(term)}`,
            sql`coalesce("d"."paystack_transaction_id", '') ilike ${likePattern(term)}`,
            sql`coalesce("u"."name", '') ilike ${likePattern(term)}`,
            sql`coalesce("u"."email", '') ilike ${likePattern(term)}`,
            sql`coalesce("w"."number", '') ilike ${likePattern(term)}`,
          ],
          sql` or `,
        )})`
      : null,
    query.status ? sql`"d"."status" = ${query.status}` : null,
    query.provider ? sql`"d"."provider" = ${query.provider}` : null,
    query.channel ? sql`"d"."paystack_channel" = ${query.channel}` : null,
    query.walletId ? sql`"d"."wallet_id" = ${query.walletId}` : null,
    query.userId ? sql`"w"."user_id" = ${query.userId}` : null,
    query.dateFrom ? sql`"d"."initiated_at" >= ${query.dateFrom}` : null,
    query.dateTo ? sql`"d"."initiated_at" <= ${query.dateTo}` : null,
    query.amountMin !== null && query.amountMin !== undefined
      ? sql`"d"."amount" >= ${query.amountMin}`
      : null,
    query.amountMax !== null && query.amountMax !== undefined
      ? sql`"d"."amount" <= ${query.amountMax}`
      : null,
  ];
  const active = parts.filter((part): part is SQL => part !== null);
  const where = active.length === 0 ? sql`true` : sql`${sql.join(active, sql` and `)}`;

  // "Did the wallet actually get credited?" is a question about the ledger, so
  // it is expressed as a HAVING over the correlated credit counts below.
  const having =
    query.credit === "credited"
      ? sql`"creditOk" > 0`
      : query.credit === "not-credited"
        ? sql`"creditOk" = 0`
        : query.credit === "reversed" && caps.reversedStatus
          ? sql`"reversedRows" > 0`
          : null;
  return { where, having };
}

function normalizePaymentQuery(query: PaymentQuery): PaymentQuery {
  return {
    ...query,
    search: parseSearch(query.search),
    status: parseEnum(query.status, DEPOSIT_STATUSES),
    provider: query.provider ? query.provider.slice(0, 40) : null,
    channel: query.channel ? query.channel.slice(0, 40) : null,
    walletId: parseId(query.walletId),
    userId: parseId(query.userId),
    dateFrom: parseDateFrom(query.dateFrom),
    dateTo: parseDateTo(query.dateTo),
    amountMin: parseAmount(query.amountMin),
    amountMax: parseAmount(query.amountMax),
    credit: parseEnum(query.credit, ["credited", "not-credited", "reversed"] as const),
  };
}

export async function loadPayments(
  input: PaymentQuery,
): Promise<
  AdminList<AdminPaymentRow> & {
    providers: string[];
    channels: string[];
    summary: Record<string, number | null>;
  }
> {
  return withSchemaFallback(async (rawCaps) => {
    const caps = toAdminCaps(rawCaps);
    const query = normalizePaymentQuery(input);
    const pageSize = parsePageSize(query.pageSize);
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const sort = PAYMENT_SORTS[query.sort ?? "recent"] ?? PAYMENT_SORTS.recent;
    const { where, having } = paymentWhere(query, caps);

    return withReadOnlyTx("admin.payments", async (tx) => {
      const inner = sql`select
          "d"."id" as "id", "d"."ref" as "ref", "d"."wallet_id" as "walletId",
          "d"."provider" as "provider", "d"."method" as "method",
          "d"."amount"::text as "amount", "d"."currency" as "currency", "d"."status" as "status",
          "d"."paystack_transaction_id" as "transactionId",
          "d"."paystack_channel" as "channel",
          "d"."paystack_gateway_response" as "gatewayResponse",
          "d"."initiated_at" as "initiatedAt", "d"."paid_at" as "paidAt",
          "d"."verified_at" as "verifiedAt", "d"."completed_at" as "completedAt",
          "d"."updated_at" as "updatedAt",
          "w"."number" as "walletNumber",
          "u"."id" as "userId", "u"."name" as "userName", "u"."email" as "userEmail", "u"."phone" as "userPhone",
          (select count(*)::int from "transactions" "t" where "t"."ref" = "d"."ref" and "t"."direction" = 'in') as "creditRows",
          (select count(*)::int from "transactions" "t" where "t"."ref" = "d"."ref" and "t"."direction" = 'in' and "t"."status" = 'successful') as "creditOk",
          ${
            caps.reversedStatus
              ? sql`(select count(*)::int from "transactions" "t" where "t"."ref" = "d"."ref" and "t"."status" = 'reversed')`
              : sql`0::int`
          } as "reversedRows",
          (select max("t"."created_at") from "transactions" "t" where "t"."ref" = "d"."ref" and "t"."direction" = 'in' and "t"."status" = 'successful') as "creditedAt"
        from "deposit_requests" "d"
        left join "wallets" "w" on "w"."id" = "d"."wallet_id"
        left join "users" "u" on "u"."id" = "w"."user_id"
        where ${where}`;

      const rows = await all<Record<string, unknown>>(
        tx,
        sql`select * from (${inner}) "p"
            ${having ? sql`where ${having}` : sql``}
            order by ${sort}
            limit ${pageSize} offset ${offsetFor(page, pageSize)}`,
      );

      const total = countRows(
        await tx.execute(
          sql`select count(*)::int as "c" from (${inner}) "p" ${having ? sql`where ${having}` : sql``}`,
        ),
      );

      const summaryRow =
        (await firstRow(
          tx,
          sql`select
                count(*)::int as "all",
                count(*) filter (where "status" = 'successful')::int as "successful",
                count(*) filter (where "status" = 'pending')::int as "pending",
                count(*) filter (where "status" = 'failed')::int as "failed",
                count(*) filter (where "status" = 'abandoned')::int as "abandoned",
                coalesce(sum("amount") filter (where "status" = 'successful'), 0)::text as "successfulValue"
              from "deposit_requests"`,
        )) ?? {};

      const providers = (
        await all<{ provider: string }>(
          tx,
          sql`select distinct "provider" as "provider" from "deposit_requests" order by "provider" asc limit 20`,
        )
      ).map((row) => String(row.provider));

      const channels = (
        await all<{ channel: string }>(
          tx,
          sql`select distinct "paystack_channel" as "channel" from "deposit_requests"
              where "paystack_channel" is not null order by "paystack_channel" asc limit 20`,
        )
      ).map((row) => String(row.channel));

      return {
        rows: rows.map((row) => mapPaymentRow(row)),
        total,
        page,
        pageSize,
        providers,
        channels,
        summary: {
          all: optionalInt(summaryRow.all),
          successful: optionalInt(summaryRow.successful),
          pending: optionalInt(summaryRow.pending),
          failed: optionalInt(summaryRow.failed),
          abandoned: optionalInt(summaryRow.abandoned),
          successfulValue: summaryRow.successfulValue === undefined
            ? null
            : money2(summaryRow.successfulValue),
        },
      };
    });
  }, "admin payments");
}

function mapPaymentRow(row: Record<string, unknown>): AdminPaymentRow {
  const creditOk = Number(row.creditOk ?? 0);
  const reversedRows = Number(row.reversedRows ?? 0);
  const creditState: AdminDepositCreditState =
    reversedRows > 0 ? "reversed" : creditOk > 0 ? "credited" : "not-credited";
  return {
    id: Number(row.id),
    ref: String(row.ref ?? ""),
    walletId: Number(row.walletId),
    walletNumber: row.walletNumber ? String(row.walletNumber) : null,
    userId: row.userId === null || row.userId === undefined ? null : Number(row.userId),
    userName: row.userName ? String(row.userName) : null,
    userEmail: maskEmail(row.userEmail),
    amount: money2(row.amount),
    currency: String(row.currency ?? "GHS"),
    status: String(row.status ?? ""),
    provider: String(row.provider ?? ""),
    method: String(row.method ?? ""),
    channel: row.channel ? String(row.channel) : null,
    gatewayResponse: clampText(row.gatewayResponse ? String(row.gatewayResponse) : null, 140),
    paystackTransactionId: row.transactionId ? String(row.transactionId) : null,
    walletCredit: creditState,
    walletCreditedAt: iso(row.creditedAt),
    initiatedAt: iso(row.initiatedAt) ?? "",
    paidAt: iso(row.paidAt),
    verifiedAt: iso(row.verifiedAt),
    completedAt: iso(row.completedAt),
    updatedAt: iso(row.updatedAt),
  };
}
