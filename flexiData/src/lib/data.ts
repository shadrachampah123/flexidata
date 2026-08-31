import { db } from "@/db";
import {
  agentProfiles,
  bundlePlans,
  priceAlerts,
  scheduledTopups,
  transactions,
  users,
  wallets,
} from "@/db/schema";
import { desc, eq, asc } from "drizzle-orm";
import { ensureSeeded } from "@/lib/seed";
import {
  TRANSACTION_INSERT_FIELDS,
  buildCompatInsert,
  isGatewaySchemaComplete,
  withSchemaFallback,
} from "@/lib/schema-compat";

export type WalletDTO = {
  id: number;
  name: string;
  number: string;
  balance: number;
  points: number;
  isAgent: boolean;
  agentTier: string | null;
  referralCode: string | null;
  email: string;
};

export type PlanDTO = {
  id: number;
  network: string;
  category: string;
  label: string;
  validity: string;
  price: number;
  retail: number;
  badge: string | null;
};

export type TxDTO = {
  id: number;
  ref: string;
  type: string;
  status: string;
  direction: string;
  title: string;
  subtitle: string;
  amount: number;
  points: number;
  network: string | null;
  recipient: string | null;
  date: string;
};

export type AlertDTO = {
  id: number;
  network: string;
  title: string;
  body: string;
  tag: string;
};

export type ScheduleDTO = {
  id: number;
  network: string;
  planLabel: string;
  price: number;
  recipient: string;
  dayOfMonth: number;
  active: boolean;
};

export type AgentDTO = {
  tier: string;
  referralCode: string;
  referrals: number;
  commission: number;
  volume: number;
};

export type WalletRow = typeof wallets.$inferSelect;

/**
 * Columns the UI needs from `transactions`. Deliberately excludes the gateway
 * columns (`fulfillment_status`, `provider_*`, ...) so history and home screens
 * still render on a database that has not been migrated for the data gateway
 * yet. `src/app/api/purchase/*` opt into those columns via schema-compat.
 */
const TX_SELECT = {
  id: transactions.id,
  ref: transactions.ref,
  type: transactions.type,
  status: transactions.status,
  direction: transactions.direction,
  title: transactions.title,
  subtitle: transactions.subtitle,
  amount: transactions.amount,
  points: transactions.points,
  network: transactions.network,
  recipient: transactions.recipient,
  createdAt: transactions.createdAt,
};

type TxRecord = Pick<typeof transactions.$inferSelect, keyof typeof TX_SELECT>;

/** Columns the UI needs from `bundle_plans` (no provider SKU dependency). */
const PLAN_SELECT = {
  id: bundlePlans.id,
  network: bundlePlans.network,
  category: bundlePlans.category,
  label: bundlePlans.label,
  validity: bundlePlans.validity,
  price: bundlePlans.price,
  retailPrice: bundlePlans.retailPrice,
  badge: bundlePlans.badge,
  sortOrder: bundlePlans.sortOrder,
};

export class WalletNotFoundError extends Error {
  constructor() {
    super("This account has no wallet yet");
    this.name = "WalletNotFoundError";
  }
}

/**
 * Fetch the wallet row for a signed-in user. Every authenticated flow goes
 * through here instead of a hard-coded `id = 1`, so users only ever see and
 * move their own money, points and ledger.
 */
export async function getWalletRowForUser(userId: number): Promise<WalletRow> {
  await ensureSeeded();
  const row = await db
    .select()
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .limit(1);
  if (!row[0]) throw new WalletNotFoundError();
  return row[0];
}

export function toWalletDTO(w: WalletRow, email = ""): WalletDTO {
  return {
    id: w.id,
    name: w.name,
    number: w.number,
    balance: Number(w.balance),
    points: w.points,
    isAgent: w.isAgent,
    agentTier: w.agentTier,
    referralCode: w.referralCode,
    email,
  };
}

function toTxDTO(t: TxRecord): TxDTO {
  return {
    id: t.id,
    ref: t.ref,
    type: t.type,
    status: t.status,
    direction: t.direction,
    title: t.title,
    subtitle: t.subtitle,
    amount: Number(t.amount),
    points: t.points,
    network: t.network,
    recipient: t.recipient,
    date: t.createdAt.toISOString(),
  };
}

export async function getRecentTransactions(walletId: number, limit = 6): Promise<TxDTO[]> {
  await ensureSeeded();
  const rows = await db
    .select(TX_SELECT)
    .from(transactions)
    .where(eq(transactions.walletId, walletId))
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
  return rows.map(toTxDTO);
}

export async function getAllTransactions(walletId: number): Promise<TxDTO[]> {
  await ensureSeeded();
  const rows = await db
    .select(TX_SELECT)
    .from(transactions)
    .where(eq(transactions.walletId, walletId))
    .orderBy(desc(transactions.createdAt))
    .limit(100);
  return rows.map(toTxDTO);
}

export async function getPlans(): Promise<PlanDTO[]> {
  await ensureSeeded();
  const rows = await db.select(PLAN_SELECT).from(bundlePlans).orderBy(asc(bundlePlans.sortOrder));
  return rows.map((p) => ({
    id: p.id,
    network: p.network,
    category: p.category,
    label: p.label,
    validity: p.validity,
    price: Number(p.price),
    retail: Number(p.retailPrice),
    badge: p.badge,
  }));
}

export async function getActiveAlerts(): Promise<AlertDTO[]> {
  await ensureSeeded();
  const rows = await db
    .select()
    .from(priceAlerts)
    .where(eq(priceAlerts.active, true))
    .orderBy(desc(priceAlerts.createdAt));
  return rows.map((a) => ({ id: a.id, network: a.network, title: a.title, body: a.body, tag: a.tag }));
}

export async function getSchedules(walletId: number): Promise<ScheduleDTO[]> {
  await ensureSeeded();
  const rows = await db
    .select()
    .from(scheduledTopups)
    .where(eq(scheduledTopups.walletId, walletId))
    .orderBy(asc(scheduledTopups.dayOfMonth));
  return rows.map((s) => ({
    id: s.id,
    network: s.network,
    planLabel: s.planLabel,
    price: Number(s.price),
    recipient: s.recipient,
    dayOfMonth: s.dayOfMonth,
    active: s.active,
  }));
}

export async function getAgentProfile(walletId: number): Promise<AgentDTO | null> {
  await ensureSeeded();
  const rows = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.walletId, walletId))
    .limit(1);
  const a = rows[0];
  if (!a) return null;
  return {
    tier: a.tier,
    referralCode: a.referralCode,
    referrals: a.referrals,
    commission: Number(a.commission),
    volume: Number(a.volume),
  };
}

/** Find another user's wallet by their registered phone number (P2P transfer). */
export async function getWalletByPhone(phone: string): Promise<WalletRow | null> {
  const rows = await db
    .select()
    .from(wallets)
    .where(eq(wallets.number, phone))
    .limit(1);
  return rows[0] ?? null;
}

export async function getUserByEmail(email: string) {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      passwordHash: users.passwordHash,
      referralCode: users.referralCode,
    })
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Write a ledger row using only the `transactions` columns the database has.
 *
 * Drizzle names every column of the table definition in an INSERT (filling in
 * `default`), so on a database that predates the data gateway migration a plain
 * `db.insert(transactions)` fails with `column "fulfillment_status" does not
 * exist` — which would take down the wallet, airtime, convert and rewards
 * screens too, not just bundle purchases. The explicit column list keeps those
 * flows working, and the gateway columns are stored as soon as the schema is
 * pushed.
 */
export async function insertTransactionRow(row: typeof transactions.$inferInsert): Promise<void> {
  await withSchemaFallback(async (compat) => {
    if (isGatewaySchemaComplete(compat, "transactions")) {
      await db.insert(transactions).values(row);
      return;
    }

    await db.execute(buildCompatInsert(compat, "transactions", TRANSACTION_INSERT_FIELDS, [row]));
  }, "ledger write");
}
