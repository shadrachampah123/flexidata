import { eq } from "drizzle-orm";
import { db } from "@/db";
import { wallets } from "@/db/schema";
import { getWalletRow, insertTransactionRow } from "@/lib/data";
import { makeRef } from "@/lib/format";

export const dynamic = "force-dynamic";

const METHODS: Record<string, { label: string; network: "MTN" | "TELECEL" | null }> = {
  momo_mtn: { label: "MTN MoMo", network: "MTN" },
  telecel_cash: { label: "Telecel Cash", network: "TELECEL" },
  card: { label: "Visa •• 4432", network: null },
};

type Body = { method?: string; amount?: number; source?: string };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const method = body.method ?? "";
    const conf = METHODS[method];
    const amount = Number(body.amount);

    if (!conf) return Response.json({ ok: false, error: "Choose a payment method" }, { status: 400 });
    if (!Number.isFinite(amount) || amount < 5 || amount > 5000) {
      return Response.json({ ok: false, error: "Amount must be between GH₵ 5 and GH₵ 5,000" }, { status: 400 });
    }

    const wallet = await getWalletRow();
    const newBalance = Number(wallet.balance) + amount;
    const ref = makeRef("FD");

    await db.update(wallets).set({ balance: newBalance.toFixed(2) }).where(eq(wallets.id, wallet.id));

    await insertTransactionRow({
      ref,
      walletId: wallet.id,
      type: "deposit",
      status: "successful",
      direction: "in",
      title: "Wallet Top-up",
      subtitle: `${conf.label}${body.source ? ` • ${body.source}` : ""}`,
      amount: amount.toFixed(2),
      points: 0,
      network: conf.network,
      recipient: null,
    });
    return Response.json({ ok: true, status: "successful", ref, balance: newBalance, method: conf.label });
  } catch (e) {
    console.error("fund error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
