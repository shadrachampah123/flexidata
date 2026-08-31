import { eq } from "drizzle-orm";
import { db } from "@/db";
import { transactions, wallets } from "@/db/schema";
import { getWalletRow } from "@/lib/data";
import { groupPhone, isValidPhone, makeRef } from "@/lib/format";

export const dynamic = "force-dynamic";

type Body = { account?: string; amount?: number };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const account = (body.account ?? "").replace(/\D/g, "");
    const amount = Number(body.amount);

    if (!isValidPhone(account)) {
      return Response.json({ ok: false, error: "Enter a valid wallet number" }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount < 1 || amount > 5000) {
      return Response.json({ ok: false, error: "Enter an amount between GH₵ 1 and GH₵ 5,000" }, { status: 400 });
    }

    const wallet = await getWalletRow();
    if (account === wallet.number.replace(/\D/g, "")) {
      return Response.json({ ok: false, error: "You can't transfer to your own wallet" }, { status: 400 });
    }
    const balance = Number(wallet.balance);
    if (balance < amount) {
      return Response.json({ ok: false, error: "insufficient_funds", balance }, { status: 402 });
    }

    const newBalance = balance - amount;
    const ref = makeRef("TR");

    await db.update(wallets).set({ balance: newBalance.toFixed(2) }).where(eq(wallets.id, wallet.id));
    await db.insert(transactions).values({
      ref,
      walletId: wallet.id,
      type: "transfer",
      status: "successful",
      direction: "out",
      title: "Wallet Transfer",
      subtitle: `To wallet ${groupPhone(account)}`,
      amount: amount.toFixed(2),
      points: 0,
      network: null,
      recipient: account,
    });

    return Response.json({ ok: true, status: "successful", ref, balance: newBalance });
  } catch (e) {
    console.error("transfer error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
