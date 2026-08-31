import { eq } from "drizzle-orm";
import { db } from "@/db";
import { transactions, wallets } from "@/db/schema";
import { getWalletRow } from "@/lib/data";
import { REDEEM_OPTIONS } from "@/lib/constants";
import { makeRef } from "@/lib/format";

export const dynamic = "force-dynamic";

type Body = { optionId?: string };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const option = REDEEM_OPTIONS.find((o) => o.id === body.optionId);
    if (!option) return Response.json({ ok: false, error: "Reward not found" }, { status: 404 });

    const wallet = await getWalletRow();
    if (wallet.points < option.cost) {
      return Response.json({ ok: false, error: "Not enough points for this reward" }, { status: 400 });
    }

    const newPoints = wallet.points - option.cost;
    const credit = option.kind === "cash" ? option.amount : 0;
    const newBalance = Number(wallet.balance) + credit;
    const ref = makeRef("RW");

    await db
      .update(wallets)
      .set({ points: newPoints, balance: newBalance.toFixed(2) })
      .where(eq(wallets.id, wallet.id));

    const titleMap: Record<string, string> = {
      cash: `Points → GH₵ ${option.amount} Cash`,
      airtime: `Points → GH₵ ${option.amount} Airtime`,
      data: `Points → ${option.amount}GB Data`,
    };

    await db.insert(transactions).values({
      ref,
      walletId: wallet.id,
      type: "redemption",
      status: "successful",
      direction: credit > 0 ? "in" : "out",
      title: titleMap[option.kind],
      subtitle: `${option.cost} pts redeemed`,
      amount: (credit > 0 ? credit : 0).toFixed(2),
      points: -option.cost,
      network: option.kind === "data" ? "MTN" : null,
      recipient: wallet.number,
    });

    return Response.json({ ok: true, status: "successful", ref, points: newPoints, balance: newBalance });
  } catch (e) {
    console.error("redeem error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
