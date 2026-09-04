import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { wallets } from "@/db/schema";
import { insertTransactionRow } from "@/lib/data";
import { requireAccount } from "@/lib/api-auth";
import { REDEEM_OPTIONS } from "@/lib/constants";
import { makeRef } from "@/lib/format";

export const dynamic = "force-dynamic";

type Body = { optionId?: string };

export async function POST(req: Request) {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;
    const { wallet } = auth;

    const body = (await req.json()) as Body;
    const option = REDEEM_OPTIONS.find((o) => o.id === body.optionId);
    if (!option) return Response.json({ ok: false, error: "Reward not found" }, { status: 404 });

    if (wallet.points < option.cost) {
      return Response.json({ ok: false, error: "Not enough points for this reward" }, { status: 400 });
    }

    const credit = option.kind === "cash" ? option.amount : 0;
    const ref = makeRef("RW");

    // Atomic, conditional redemption. The `points >= cost` guard lives in the
    // UPDATE itself and points/balance move by SQL arithmetic, so two concurrent
    // redemptions cannot both spend the same points (which used to credit cash
    // twice — creating wallet money that was never earned), and a concurrent
    // deposit/transfer can no longer be clobbered by a read-modify-write.
    const redeemed = await db
      .update(wallets)
      .set({
        points: sql`${wallets.points} - ${option.cost}`,
        ...(credit > 0 ? { balance: sql`${wallets.balance} + ${credit.toFixed(2)}::numeric` } : {}),
      })
      .where(and(eq(wallets.id, wallet.id), gte(wallets.points, option.cost)))
      .returning({ points: wallets.points, balance: wallets.balance });

    const updated = redeemed[0];
    if (!updated) {
      // Lost the race against a concurrent redemption.
      return Response.json({ ok: false, error: "Not enough points for this reward" }, { status: 400 });
    }

    const newPoints = updated.points;
    const newBalance = Number(updated.balance);

    const titleMap: Record<string, string> = {
      cash: `Points → GH₵ ${option.amount} Cash`,
      airtime: `Points → GH₵ ${option.amount} Airtime`,
      data: `Points → ${option.amount}GB Data`,
    };

    await insertTransactionRow({
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
