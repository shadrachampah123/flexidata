import { eq } from "drizzle-orm";
import { db } from "@/db";
import { depositRequests, users, wallets } from "@/db/schema";
import { insertTransactionRow } from "@/lib/data";
import { requireAccount } from "@/lib/api-auth";
import { PAYMENT_METHODS, initPayment, paymentsProvider, type PaymentMethod } from "@/lib/payments";
import { makeRef } from "@/lib/format";

export const dynamic = "force-dynamic";

type Body = { method?: string; amount?: number };

export async function POST(req: Request) {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;
    const { wallet } = auth;

    const body = (await req.json()) as Body;
    const method = (body.method ?? "") as PaymentMethod;
    const conf = PAYMENT_METHODS[method];
    const amount = Number(body.amount);

    if (!conf) return Response.json({ ok: false, error: "Choose a payment method" }, { status: 400 });
    if (!Number.isFinite(amount) || amount < 5 || amount > 5000) {
      return Response.json({ ok: false, error: "Amount must be between GH₵ 5 and GH₵ 5,000" }, { status: 400 });
    }

    const ref = makeRef("DP");

    // Record the attempt up front so a Paystack redirect can never be lost.
    await db.insert(depositRequests).values({
      ref,
      walletId: wallet.id,
      provider: paymentsProvider(),
      method,
      amount: amount.toFixed(2),
      status: "pending",
    });

    const accountRows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1);
    const email = accountRows[0]?.email ?? `${wallet.number}@flexidata.app`;

    const paymentResult = await initPayment({
      ref,
      amountGhs: amount,
      email,
      method,
      phone: wallet.number,
    }).catch((e: unknown) => {
      throw e instanceof Error ? e : new Error("Payment provider error");
    });

    if (paymentResult.status === "pending") {
      await db
        .update(depositRequests)
        .set({ providerReference: paymentResult.providerRef })
        .where(eq(depositRequests.ref, ref));
      return Response.json({
        ok: true,
        status: "pending",
        ref,
        authorizationUrl: paymentResult.authorizationUrl,
        provider: paymentsProvider(),
      });
    }

    // Mock (or instant) settlement — credit the wallet idempotently.
    await settleDeposit(ref);

    return Response.json({
      ok: true,
      status: "successful",
      ref,
      balance: Number((await reloadBalance(wallet.id)).balance),
      method: conf.label,
      provider: paymentsProvider(),
    });
  } catch (e) {
    console.error("fund error", e);
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "Something went wrong" },
      { status: 500 },
    );
  }
}

async function reloadBalance(walletId: number) {
  const rows = await db.select().from(wallets).where(eq(wallets.id, walletId)).limit(1);
  return rows[0];
}

/**
 * Credit a settled deposit exactly once. Safe to call from the instant mock
 * path, the Paystack verify endpoint and the Paystack webhook.
 */
export async function settleDeposit(ref: string): Promise<{ credited: boolean; amount?: number }> {
  const rows = await db
    .select()
    .from(depositRequests)
    .where(eq(depositRequests.ref, ref))
    .limit(1);
  const deposit = rows[0];
  if (!deposit) return { credited: false };
  if (deposit.status === "successful") return { credited: false, amount: Number(deposit.amount) };

  await db
    .update(depositRequests)
    .set({ status: "successful", completedAt: new Date() })
    .where(eq(depositRequests.ref, ref));

  const amount = Number(deposit.amount);
  const methodLabel = PAYMENT_METHODS[deposit.method as PaymentMethod]?.label ?? "Card";

  const walletRows = await db
    .select({ id: wallets.id, balance: wallets.balance, number: wallets.number })
    .from(wallets)
    .where(eq(wallets.id, deposit.walletId))
    .limit(1);
  const wallet = walletRows[0];
  if (!wallet) return { credited: false };

  const newBalance = Number(wallet.balance) + amount;
  await db.update(wallets).set({ balance: newBalance.toFixed(2) }).where(eq(wallets.id, wallet.id));

  await insertTransactionRow({
    ref,
    walletId: wallet.id,
    type: "deposit",
    status: "successful",
    direction: "in",
    title: "Wallet Top-up",
    subtitle: `${methodLabel} • ${wallet.number}`,
    amount: amount.toFixed(2),
    points: 0,
    network: PAYMENT_METHODS[deposit.method as PaymentMethod]?.network ?? null,
    recipient: null,
  });

  return { credited: true, amount };
}
