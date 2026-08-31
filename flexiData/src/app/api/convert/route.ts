import { eq } from "drizzle-orm";
import { db } from "@/db";
import { wallets } from "@/db/schema";
import { getWalletRow, insertTransactionRow } from "@/lib/data";
import { conversionFeeRate } from "@/lib/constants";
import { groupPhone, isValidPhone, makeRef } from "@/lib/format";

export const dynamic = "force-dynamic";

type Body = { network?: string; phone?: string; amount?: number };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const { network, phone } = body;
    const amount = Number(body.amount);

    if (!network || (network !== "MTN" && network !== "TELECEL")) {
      return Response.json({ ok: false, error: "Choose a network" }, { status: 400 });
    }
    if (!phone || !isValidPhone(phone)) {
      return Response.json({ ok: false, error: "Enter the number holding the airtime" }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount < 5 || amount > 1000) {
      return Response.json({ ok: false, error: "Amount must be between GH₵ 5 and GH₵ 1,000" }, { status: 400 });
    }

    const wallet = await getWalletRow();
    const feeRate = conversionFeeRate(amount);
    const fee = Math.round(amount * feeRate * 100) / 100;
    const payout = Math.round((amount - fee) * 100) / 100;

    const status = Math.random() < 0.92 ? "successful" : "pending";
    const ref = makeRef("CV");
    const newBalance = status === "successful" ? Number(wallet.balance) + payout : Number(wallet.balance);

    if (status === "successful") {
      await db
        .update(wallets)
        .set({ balance: newBalance.toFixed(2) })
        .where(eq(wallets.id, wallet.id));
    }

    await insertTransactionRow({
      ref,
      walletId: wallet.id,
      type: "conversion",
      status,
      direction: "in",
      title: "Airtime → Cash",
      subtitle: `From ${groupPhone(phone)} • Fee ${Math.round(feeRate * 100)}%`,
      amount: payout.toFixed(2),
      points: 0,
      network,
      recipient: phone,
    });
    return Response.json({
      ok: true,
      status,
      ref,
      payout,
      fee,
      feePct: Math.round(feeRate * 100),
      balance: newBalance,
    });
  } catch (e) {
    console.error("convert error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
