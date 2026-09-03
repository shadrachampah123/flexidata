import {
  pgTable,
  serial,
  varchar,
  numeric,
  integer,
  boolean,
  timestamp,
  pgEnum,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const txTypeEnum = pgEnum("tx_type", [
  "data",
  "airtime",
  "conversion",
  "deposit",
  "transfer",
  "redemption",
  "referral",
]);

export const txStatusEnum = pgEnum("tx_status", ["successful", "pending", "failed", "reversed"]);

export const fulfillmentStatusEnum = pgEnum("fulfillment_status", [
  "queued",
  "submitted",
  "processing",
  "delivered",
  "failed",
  "refunded",
]);

export const directionEnum = pgEnum("direction", ["in", "out"]);

export const depositStatusEnum = pgEnum("deposit_status", [
  "pending",
  "successful",
  "failed",
  "abandoned",
]);

export const checkoutPaymentStatusEnum = pgEnum("checkout_payment_status", [
  "pending",
  "successful",
  "failed",
  "abandoned",
]);

export const checkoutOrderStatusEnum = pgEnum("checkout_order_status", [
  "awaiting_payment",
  "payment_failed",
  "abandoned",
  "paid",
  "fulfilling",
  "fulfilled",
  "fulfillment_failed",
]);


/**
 * Registered FlexiData accounts. One user owns exactly one wallet
 * (`wallets.userId`). Authentication is email + scrypt-hashed password;
 * sessions live in the `sessions` table.
 */
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    email: varchar("email", { length: 160 }).notNull().unique(),
    phone: varchar("phone", { length: 20 }).notNull().unique(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    referralCode: varchar("referral_code", { length: 20 }).notNull().unique(),
    referredBy: integer("referred_by"),
    referralRewardedAt: timestamp("referral_rewarded_at", { withTimezone: true }),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    notifyPromos: boolean("notify_promos").notNull().default(true),
    notifyTx: boolean("notify_tx").notNull().default(true),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Deliberately NOT unique: many users share one referrer. The "pay a
  // referrer only once" rule lives on `referralRewardedAt`, not here — a
  // unique index would reject the 2nd+ signup using any referral code.
  (table) => [index("users_referred_by_idx").on(table.referredBy)],
);

/**
 * Signed-in devices. The raw session token only ever lives in the user's
 * httpOnly cookie; the database stores its SHA-256 hash so a database leak
 * cannot be replayed as a session.
 */
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  userAgent: varchar("user_agent", { length: 240 }),
  ip: varchar("ip", { length: 64 }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** Single-use password reset tokens (hashed at rest, 1 hour expiry). */
export const passwordResets = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const wallets = pgTable("wallets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  number: varchar("number", { length: 20 }).notNull().unique(),
  balance: numeric("balance", { precision: 12, scale: 2 }).notNull().default("0"),
  points: integer("points").notNull().default(0),
  isAgent: boolean("is_agent").notNull().default(false),
  agentTier: varchar("agent_tier", { length: 40 }),
  referralCode: varchar("referral_code", { length: 20 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bundlePlans = pgTable("bundle_plans", {
  id: serial("id").primaryKey(),
  network: varchar("network", { length: 10 }).notNull(), // MTN | TELECEL
  category: varchar("category", { length: 40 }).notNull(),
  label: varchar("label", { length: 80 }).notNull(),
  providerProductCode: varchar("provider_product_code", { length: 80 }).notNull(),
  validity: varchar("validity", { length: 60 }).notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  retailPrice: numeric("retail_price", { precision: 10, scale: 2 }).notNull(),
  badge: varchar("badge", { length: 20 }),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  ref: varchar("ref", { length: 40 }).notNull().unique(),
  walletId: integer("wallet_id").notNull(),
  type: txTypeEnum("type").notNull(),
  status: txStatusEnum("status").notNull(),
  fulfillmentStatus: fulfillmentStatusEnum("fulfillment_status").notNull().default("queued"),
  direction: directionEnum("direction").notNull(),
  title: varchar("title", { length: 140 }).notNull(),
  subtitle: varchar("subtitle", { length: 200 }).notNull().default(""),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  points: integer("points").notNull().default(0),
  network: varchar("network", { length: 10 }),
  recipient: varchar("recipient", { length: 20 }),
  provider: varchar("provider", { length: 40 }),
  providerProductCode: varchar("provider_product_code", { length: 80 }),
  providerReference: varchar("provider_reference", { length: 120 }),
  providerStatus: varchar("provider_status", { length: 80 }),
  providerMessage: varchar("provider_message", { length: 240 }),
  fulfillmentAttempts: integer("fulfillment_attempts").notNull().default(0),
  chargedAt: timestamp("charged_at", { withTimezone: true }),
  fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  lastProviderSyncAt: timestamp("last_provider_sync_at", { withTimezone: true }),
  providerPayload: jsonb("provider_payload"),
  providerResponse: jsonb("provider_response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const providerFloatBalances = pgTable(
  "provider_float_balances",
  {
    id: serial("id").primaryKey(),
    providerCode: varchar("provider_code", { length: 40 }).notNull(),
    network: varchar("network", { length: 10 }).notNull(),
    currency: varchar("currency", { length: 8 }).notNull().default("GHS"),
    availableBalance: numeric("available_balance", { precision: 12, scale: 2 }).notNull().default("0"),
    reservedBalance: numeric("reserved_balance", { precision: 12, scale: 2 }).notNull().default("0"),
    lowBalanceThreshold: numeric("low_balance_threshold", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    lastReference: varchar("last_reference", { length: 40 }),
    lastStatus: varchar("last_status", { length: 80 }),
    notes: varchar("notes", { length: 240 }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_float_balances_provider_network_idx").on(table.providerCode, table.network),
  ],
);

/**
 * Wallet funding attempts. In mock mode a deposit is credited instantly; with
 * Paystack the row starts `pending` and is settled by the verify call /
 * webhook (idempotent on `ref`), exactly like the data-bundle checkout flow.
 *
 * Money-safety (mirrors `checkout_orders`):
 *  - `amount_subunits` (pesewas) is the integer Paystack must confirm before a
 *    wallet is ever credited; `amount` is the display value.
 *  - Settlement is a single conditional UPDATE (`pending/abandoned/failed` →
 *    `successful`) inside one database transaction that also increments the
 *    wallet balance and writes the ledger row, so concurrent webhook / verify
 *    calls can never double-credit.
 *  - The Paystack audit columns never hold key material — just the public
 *    transaction id, channel and gateway message.
 */
export const depositRequests = pgTable(
  "deposit_requests",
  {
    id: serial("id").primaryKey(),
    ref: varchar("ref", { length: 40 }).notNull().unique(),
    walletId: integer("wallet_id").notNull(),
    provider: varchar("provider", { length: 40 }).notNull().default("mock"),
    method: varchar("method", { length: 40 }).notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    // Integer pesewas — the exact amount Paystack verification must return.
    amountSubunits: integer("amount_subunits").notNull().default(0),
    currency: varchar("currency", { length: 8 }).notNull().default("GHS"),
    status: depositStatusEnum("status").notNull().default("pending"),
    providerReference: varchar("provider_reference", { length: 120 }),
    // Paystack audit trail (public data only — never key material).
    paystackTransactionId: varchar("paystack_transaction_id", { length: 40 }),
    paystackChannel: varchar("paystack_channel", { length: 40 }),
    paystackGatewayResponse: varchar("paystack_gateway_response", { length: 240 }),
    initiatedAt: timestamp("initiated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    providerPayload: jsonb("provider_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("deposit_requests_wallet_idx").on(table.walletId),
    index("deposit_requests_status_idx").on(table.status),
    // Defense-in-depth: a single Paystack transaction must not be attached to
    // more than one deposit request. PostgreSQL allows multiple NULLs, so this
    // protects every real transaction id without breaking rows that have not
    // been settled yet.
    uniqueIndex("deposit_requests_paystack_transaction_id_idx").on(table.paystackTransactionId),
  ],
);

/**
 * Pay-as-you-go data bundle orders paid through Paystack checkout (no wallet
 * balance involved). One row is the single source of truth for an order:
 *
 *   awaiting_payment ─▶ paid ─▶ fulfilling ─▶ fulfilled
 *          │                        └───────▶ fulfillment_failed
 *          ├──▶ payment_failed
 *          └──▶ abandoned (customer left checkout; may still become paid)
 *
 * `ref` doubles as the Paystack transaction reference and, once fulfilled, as
 * the ledger `transactions.ref` so history/tracking work unchanged. All
 * status transitions are performed with conditional UPDATEs so duplicate
 * webhooks / verify calls can never settle a payment twice or submit the
 * bundle to the data provider (YenkoData) twice.
 */
export const checkoutOrders = pgTable(
  "checkout_orders",
  {
    id: serial("id").primaryKey(),
    /** Our unique order reference; also the Paystack transaction reference. */
    ref: varchar("ref", { length: 40 }).notNull().unique(),
    userId: integer("user_id").notNull(),
    walletId: integer("wallet_id").notNull(),
    customerEmail: varchar("customer_email", { length: 160 }).notNull(),
    customerPhone: varchar("customer_phone", { length: 20 }).notNull(),
    // Selected bundle, resolved server-side from bundle_plans (never client input).
    network: varchar("network", { length: 10 }).notNull(),
    category: varchar("category", { length: 40 }).notNull(),
    planLabel: varchar("plan_label", { length: 80 }).notNull(),
    providerProductCode: varchar("provider_product_code", { length: 80 }).notNull(),
    recipient: varchar("recipient", { length: 20 }).notNull(),
    // Money. `amount_subunits` (pesewas) is the integer Paystack must confirm.
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    amountSubunits: integer("amount_subunits").notNull(),
    currency: varchar("currency", { length: 8 }).notNull().default("GHS"),
    paymentStatus: checkoutPaymentStatusEnum("payment_status").notNull().default("pending"),
    orderStatus: checkoutOrderStatusEnum("order_status").notNull().default("awaiting_payment"),
    fulfillmentStatus: fulfillmentStatusEnum("fulfillment_status").notNull().default("queued"),
    // Paystack audit trail (never contains key material).
    paystackTransactionId: varchar("paystack_transaction_id", { length: 40 }),
    paystackChannel: varchar("paystack_channel", { length: 40 }),
    paystackGatewayResponse: varchar("paystack_gateway_response", { length: 240 }),
    // Data-provider (YenkoData) audit trail.
    providerReference: varchar("provider_reference", { length: 120 }),
    providerStatus: varchar("provider_status", { length: 80 }),
    providerMessage: varchar("provider_message", { length: 240 }),
    // Timestamps.
    paidAt: timestamp("paid_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("checkout_orders_user_idx").on(table.userId),
    index("checkout_orders_status_idx").on(table.orderStatus),
    // Defense-in-depth: a single Paystack transaction must not mark more than
    // one checkout order as paid. NULLs are allowed for unpaid/unknown orders.
    uniqueIndex("checkout_orders_paystack_transaction_id_idx").on(table.paystackTransactionId),
  ],
);

export const scheduledTopups = pgTable("scheduled_topups", {

  id: serial("id").primaryKey(),
  walletId: integer("wallet_id").notNull(),
  network: varchar("network", { length: 10 }).notNull(),
  planLabel: varchar("plan_label", { length: 80 }).notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  recipient: varchar("recipient", { length: 20 }).notNull(),
  dayOfMonth: integer("day_of_month").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const priceAlerts = pgTable("price_alerts", {
  id: serial("id").primaryKey(),
  network: varchar("network", { length: 10 }).notNull(),
  title: varchar("title", { length: 140 }).notNull(),
  body: varchar("body", { length: 240 }).notNull(),
  tag: varchar("tag", { length: 20 }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentProfiles = pgTable("agent_profiles", {
  id: serial("id").primaryKey(),
  walletId: integer("wallet_id").notNull().unique(),
  tier: varchar("tier", { length: 40 }).notNull().default("Starter"),
  referralCode: varchar("referral_code", { length: 20 }).notNull().unique(),
  referrals: integer("referrals").notNull().default(0),
  commission: numeric("commission", { precision: 12, scale: 2 }).notNull().default("0"),
  volume: numeric("volume", { precision: 12, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
