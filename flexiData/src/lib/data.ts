import { db } from "@/db";
import {
  agentProfiles,
  bundlePlans,
  priceAlerts,
  scheduledTopups,
  transactions,
  wallets,
} from "@/db/schema";
import { desc, eq, asc } from "drizzle-orm";
import { ensureSeeded } from "@/lib/seed";

export type WalletDTO = {
  id: number;
  name: string;
  number: string;
  balance: number;
  points: number;
  isAgent: boolean;
  agentTier: string | null;
  referralCode: string | null;
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

export async function getWalletRow(): Promise<WalletRow> {
  await ensureSeeded();
  const row = await db.select().from(wallets).where(eq(wallets.id, 1)).limit(1);
  if (!row[0]) throw new Error("Demo wallet missing");
  return row[0];
}

export function toWalletDTO(w: WalletRow): WalletDTO {
  return {
    id: w.id,
    name: w.name,
    number: w.number,
    balance: Number(w.balance),
    points: w.points,
    isAgent: w.isAgent,
    agentTier: w.agentTier,
    referralCode: w.referralCode,
  };
}

function toTxDTO(t: typeof transactions.$inferSelect): TxDTO {
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

export async function getRecentTransactions(limit = 6): Promise<TxDTO[]> {
  await ensureSeeded();
  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.walletId, 1))
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
  return rows.map(toTxDTO);
}

export async function getAllTransactions(): Promise<TxDTO[]> {
  await ensureSeeded();
  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.walletId, 1))
    .orderBy(desc(transactions.createdAt))
    .limit(100);
  return rows.map(toTxDTO);
}

export async function getPlans(): Promise<PlanDTO[]> {
  await ensureSeeded();
  const rows = await db.select().from(bundlePlans).orderBy(asc(bundlePlans.sortOrder));
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

export async function getSchedules(): Promise<ScheduleDTO[]> {
  await ensureSeeded();
  const rows = await db
    .select()
    .from(scheduledTopups)
    .where(eq(scheduledTopups.walletId, 1))
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

export async function getAgentProfile(): Promise<AgentDTO | null> {
  await ensureSeeded();
  const rows = await db.select().from(agentProfiles).where(eq(agentProfiles.walletId, 1)).limit(1);
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

export async function getWallet(): Promise<WalletDTO> {
  const w = await getWalletRow();
  return toWalletDTO(w);
}
