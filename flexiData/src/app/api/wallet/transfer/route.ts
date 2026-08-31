import { eq } from "drizzle-orm";
import { db } from "@/db";
import { wallets } from "@/db/schema";
import { getWalletByPhone, insertTransactionRow } from "@/lib/data";
import { requireAccount } from "@/lib/api-auth";
import { groupPhone, isValidPhone, makeRef, normalizePhoneDigits } from "@/lib/format";

export const dynamic = "force-dynamic";

type Body = { account?: string; amount?: number };

export async function POST(req: Request) {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;
    const { wallet } = auth;

    const body = (await req.json()) as Body;
    const account = normalizePhoneDigits(body.account ?? "");
    const amount = Number(body.amount);

    if (!isValidPhone(account)) {
      return Response.json({ ok: false, error: "Enter a valid FlexiData wallet number" }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount < 1 || amount > 5000) {
      return Response.json({ ok: false, error: "Enter an amount between GH₵ 1 and GH₵ 5,000" }, { status: 400 });
    }
    if (account === wallet.number) {
      return Response.json({ ok: false, error: "You can't transfer to your own wallet" }, { status: 400 });
    }

    const balance = Number(wallet.balance);
    if (balance < amount) {
      return Response.json({ ok: false, error: "insufficient_funds", balance }, { status: 402 });
    }

    const recipient = await getWalletByPhone(account);
    if (!recipient) {
      return Response.json(
        { ok: false, error: "No FlexiData account found for that number. Ask them to register." },
        { status: 404 },
      );
    }

    const ref = makeRef("TR");
    const newBalance = Math.round((balance - amount) * 100) / 100;
    const recipientNewBalance = Math.round((Number(recipient.balance) + amount) * 100) / 100;

    // Both legs of the transfer.
    await db.update(wallets).set({ balance: newBalance.toFixed(2) }).where(eq(wallets.id, wallet.id));
    await db
      .update(wallets)
      .set({ balance: recipientNewBalance.toFixed(2) })
      .where(eq(wallets.id, recipient.id));

    await insertTransactionRow({
      ref,
      walletId: wallet.id,
      type: "transfer",
      status: "successful",
      direction: "out",
      title: "Wallet Transfer",
      subtitle: `To ${recipient.name} • ${groupPhone(account)}`,
      amount: amount.toFixed(2),
      points: 0,
      network: null,
      recipient: account,
    });

    await insertTransactionRow({
      ref: `${ref}-IN`,
      walletId: recipient.id,
      type: "transfer",
      status: "successful",
      direction: "in",
      title: "Wallet Received",
      subtitle: `From ${wallet.name} • ${groupPhone(wallet.number)}`,
      amount: amount.toFixed(2),
      points: 0,
      network: null,
      recipient: wallet.number,
    });

    return Response.json({ ok: true, status: "successful", ref, balance: newBalance });
  } catch (e) {
    console.error("transfer error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
