import { db } from "@/db";
import { bundlePlans, priceAlerts, scheduledTopups, transactions, wallets } from "@/db/schema";
import { sql } from "drizzle-orm";
import { makeRef } from "@/lib/format";

let seedPromise: Promise<void> | null = null;

const H = 3600 * 1000;
const D = 24 * H;

export function ensureSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = runSeed().catch((e) => {
      seedPromise = null;
      throw e;
    });
  }
  return seedPromise;
}

async function runSeed(): Promise<void> {
  const rows = await db.execute(sql`select count(*)::int as c from wallets`);
  const count = (rows.rows[0] as { c: number }).c;
  if (count > 0) return;

  const now = Date.now();

  await db
    .insert(wallets)
    .values({
      id: 1,
      name: "Kwame Boateng",
      number: "0532198840",
      balance: "128.50",
      points: 2450,
    })
    .onConflictDoNothing();

  const plans: (typeof bundlePlans.$inferInsert)[] = [];
  const add = (
    network: string,
    category: string,
    label: string,
    validity: string,
    price: string,
    retail: string,
    badge: string | null = null,
  ) =>
    plans.push({
      network,
      category,
      label,
      validity,
      price,
      retailPrice: retail,
      badge,
      sortOrder: plans.length,
    });

  add("MTN", "up2u", "1GB", "3 days", "4.50", "6.00");
  add("MTN", "up2u", "2GB", "7 days", "8.50", "11.00");
  add("MTN", "up2u", "4GB", "30 days", "15.00", "20.00", "POPULAR");
  add("MTN", "up2u", "6GB", "30 days", "21.00", "28.00");
  add("MTN", "up2u", "10GB", "30 days", "34.00", "42.00");
  add("MTN", "up2u", "15GB", "30 days", "48.00", "62.00");

  add("MTN", "sme", "1GB", "Non-expiry", "4.00", "5.50");
  add("MTN", "sme", "2GB", "Non-expiry", "7.50", "10.00");
  add("MTN", "sme", "5GB", "Non-expiry", "17.50", "23.00", "POPULAR");
  add("MTN", "sme", "10GB", "Non-expiry", "33.00", "42.00");
  add("MTN", "sme", "20GB", "Non-expiry", "62.00", "78.00");
  add("MTN", "sme", "50GB", "Non-expiry", "148.00", "185.00");

  add("MTN", "corporate", "5GB", "30 days", "22.00", "27.00");
  add("MTN", "corporate", "10GB", "30 days", "40.00", "50.00", "B2B");
  add("MTN", "corporate", "25GB", "30 days", "92.00", "112.00");
  add("MTN", "corporate", "50GB", "30 days", "175.00", "210.00");
  add("MTN", "corporate", "100GB", "30 days", "330.00", "400.00");

  add("MTN", "social", "WhatsApp 1GB", "7 days", "2.00", "3.00");
  add("MTN", "social", "Social Mix 2.5GB", "14 days", "6.00", "8.00", "HOT");
  add("MTN", "social", "TikTok + X 1GB", "7 days", "3.00", "4.50");
  add("MTN", "social", "Streaming 3GB", "7 days", "7.50", "10.00");

  add("TELECEL", "tdata", "1GB", "3 days", "3.80", "5.00");
  add("TELECEL", "tdata", "2.5GB", "7 days", "8.00", "11.00");
  add("TELECEL", "tdata", "5GB", "30 days", "16.00", "21.00", "POPULAR");
  add("TELECEL", "tdata", "10GB", "30 days", "31.00", "40.00");
  add("TELECEL", "tdata", "15GB", "30 days", "45.00", "58.00");
  add("TELECEL", "tdata", "30GB", "30 days", "85.00", "108.00");

  add("TELECEL", "just4u", "1.5GB Daily Vibe", "1 day", "4.00", "5.50");
  add("TELECEL", "just4u", "3GB Weekend", "3 days", "6.50", "9.00", "HOT");
  add("TELECEL", "just4u", "7GB Red Vibes", "7 days", "14.00", "19.00");
  add("TELECEL", "just4u", "12GB Super", "30 days", "26.00", "34.00");

  add("TELECEL", "gifting", "5GB", "30 days", "23.00", "28.00");
  add("TELECEL", "gifting", "10GB", "30 days", "42.00", "52.00");
  add("TELECEL", "gifting", "20GB", "30 days", "78.00", "98.00");

  await db.insert(bundlePlans).values(plans);

  const tx = (
    ref: string,
    type: "data" | "airtime" | "conversion" | "deposit" | "transfer" | "redemption",
    status: "successful" | "pending" | "failed",
    direction: "in" | "out",
    title: string,
    subtitle: string,
    amount: string,
    points: number,
    network: string | null,
    recipient: string | null,
    agoMs: number,
  ) => ({
    ref,
    walletId: 1,
    type,
    status,
    direction,
    title,
    subtitle,
    amount,
    points,
    network,
    recipient,
    createdAt: new Date(now - agoMs),
  });

  await db.insert(transactions).values([
    tx(makeRef(), "data", "pending", "out", "Telecel 10GB Data", "To 020 987 6543", "31.00", 0, "TELECEL", "0209876543", 4 * 60000),
    tx(makeRef(), "data", "successful", "out", "MTN 5GB SME Data", "To 027 345 6789", "17.50", 35, "MTN", "0273456789", 2 * H),
    tx(makeRef(), "deposit", "successful", "in", "Wallet Top-up", "MTN MoMo • 053 219 8840", "50.00", 0, "MTN", null, 1 * D),
    tx(makeRef(), "airtime", "successful", "out", "MTN Airtime GH₵ 10", "To 024 412 3456 • 2% off", "9.80", 20, "MTN", "0244123456", 2 * D),
    tx(makeRef(), "conversion", "successful", "in", "Airtime → Cash", "From 024 412 3456 • Fee 12%", "17.60", 0, "MTN", "0244123456", 3 * D),
    tx(makeRef(), "data", "failed", "out", "MTN 15GB UP2U", "To 055 678 9012 • Not charged", "48.00", 0, "MTN", "0556789012", 3 * D + 5 * H),
    tx(makeRef(), "redemption", "successful", "out", "Points → GH₵ 5 Airtime", "300 pts redeemed", "0.00", -300, null, null, 4 * D),
    tx(makeRef(), "airtime", "successful", "out", "Telecel Airtime GH₵ 20", "To 020 987 6543 • 2% off", "19.60", 39, "TELECEL", "0209876543", 5 * D),
    tx(makeRef(), "transfer", "successful", "out", "Wallet Transfer", "To wallet 053 211 8329", "30.00", 0, null, "0532118329", 6 * D),
    tx(makeRef(), "data", "successful", "out", "MTN 2GB UP2U", "To 050 123 4567", "8.50", 17, "MTN", "0501234567", 8 * D),
    tx(makeRef(), "deposit", "successful", "in", "Wallet Top-up", "Telecel Cash • 020 987 6543", "100.00", 0, "TELECEL", null, 9 * D),
  ]);

  await db.insert(priceAlerts).values([
    {
      network: "MTN",
      title: "Flash drop — 10GB UP2U now GH₵ 29.50",
      body: "Weekend promo ends Sunday 11:59 PM. Limited pool, first come first served.",
      tag: "-22%",
    },
    {
      network: "TELECEL",
      title: "Just4U 7GB Red Vibes at GH₵ 11.99",
      body: "Personalised red deals refreshed for this weekend only.",
      tag: "-14%",
    },
    {
      network: "MTN",
      title: "Agent unlock — SME 20GB at GH₵ 58",
      body: "Registered agents get this wholesale rate all week.",
      tag: "AGENT",
    },
  ]);

  await db.insert(scheduledTopups).values({
    walletId: 1,
    network: "MTN",
    planLabel: "5GB SME Data",
    price: "17.50",
      recipient: "0273456789",
      dayOfMonth: 1,
    })
    .onConflictDoNothing();
}
