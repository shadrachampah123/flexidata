import {
  pgTable,
  serial,
  varchar,
  numeric,
  integer,
  boolean,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";

export const txTypeEnum = pgEnum("tx_type", [
  "data",
  "airtime",
  "conversion",
  "deposit",
  "transfer",
  "redemption",
]);

export const txStatusEnum = pgEnum("tx_status", [
  "successful",
  "pending",
  "failed",
]);

export const directionEnum = pgEnum("direction", ["in", "out"]);

export const wallets = pgTable("wallets", {
  id: serial("id").primaryKey(),
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
  direction: directionEnum("direction").notNull(),
  title: varchar("title", { length: 140 }).notNull(),
  subtitle: varchar("subtitle", { length: 200 }).notNull().default(""),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  points: integer("points").notNull().default(0),
  network: varchar("network", { length: 10 }),
  recipient: varchar("recipient", { length: 20 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
