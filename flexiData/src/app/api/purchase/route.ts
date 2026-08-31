import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { bundlePlans, transactions, wallets } from "@/db/schema";
import { getWalletRow } from "@/lib/data";
import { AIRTIME_DISCOUNT, POINTS_RATE } from "@/lib/constants";
import { groupPhone, isValidPhone, makeRef } from "@/lib/format";

export const dynamic = "force-dynamic";

type Body = {
  kind?: "data" | "airtime";
  network?: string;
  category?: string;
  planLabel?: string;
  amount?: number;
  recipient?: string;
};

function rollStatus(): "successful" | "pending" | "failed" {
  const r = Math.random();
  if (r < 0.88) return "successful";
  if (r < 0.96) return "pending";
  return "failed";
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const { kind, network, recipient } = body;

    if (!network || (network !== "MTN" && network !== "TELECEL")) {
      return Response.json({ ok: false, error: "Choose a network" }, { status: 400 });
    }
    if (!recipient || !isValidPhone(recipient)) {
      return Response.json({ ok: false, error: "Enter a valid recipient number" }, { status: 400 });
    }

    const wallet = await getWalletRow();

    let cost = 0;
    let title = "";
    let subtitle = `To ${groupPhone(recipient)}`;

    if (kind === "data") {
      const rows = await db
        .select()
        .from(bundlePlans)
        .where(and(eq(bundlePlans.network, network), eq(bundlePlans.label, body.planLabel ?? "")))
        .limit(1);
      const plan = rows[0];
      if (!plan) return Response.json({ ok: false, error: "Bundle not found" }, { status: 404 });
      cost = Number(plan.price);
      title = `${network} ${plan.label} Data`;
    } else if (kind === "airtime") {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
        return Response.json({ ok: false, error: "Enter an amount between GH₵ 1 and GH₵ 500" }, { status: 400 });
      }
      cost = Math.round(amount * (1 - AIRTIME_DISCOUNT) * 100) / 100;
      title = `${network} Airtime GH₵ ${amount.toFixed(0)}`;
      subtitle = `To ${groupPhone(recipient)} • ${(AIRTIME_DISCOUNT * 100).toFixed(0)}% off`;
    } else {
      return Response.json({ ok: false, error: "Unknown purchase type" }, { status: 400 });
    }

    const balance = Number(wallet.balance);
    if (balance < cost) {
      return Response.json({ ok: false, error: "insufficient_funds", needed: cost, balance }, { status: 402 });
    }

    const status = rollStatus();
    const ref = makeRef();
    const newBalance = status === "failed" ? balance : balance - cost;
    const pointsEarned = status === "successful" ? Math.max(1, Math.round(cost * POINTS_RATE)) : 0;

    if (status !== "failed") {
      await db
        .update(wallets)
        .set({
          balance: newBalance.toFixed(2),
          points: wallet.points + pointsEarned,
        })
        .where(eq(wallets.id, wallet.id));
    }

    await db.insert(transactions).values({
      ref,
      walletId: wallet.id,
      type: kind,
      status,
      direction: "out",
      title,
      subtitle: status === "failed" ? `${subtitle} • Not charged` : subtitle,
      amount: cost.toFixed(2),
      points: pointsEarned,
      network,
      recipient,
    });

    return Response.json({
      ok: true,
      status,
      ref,
      title,
      cost,
      pointsEarned,
      balance: newBalance,
      points: wallet.points + pointsEarned,
    });
  } catch (e) {
    console.error("purchase error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
