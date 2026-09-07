import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/api-auth";
import { db } from "@/db";
import { users, wallets, withdrawalRequests, transactions } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { normalizePhoneDigits, isValidPhone } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;
    const { wallet, userId } = auth;
    
    const body = await req.json();
    const { amount, method, dest } = body;

    const numAmount = Number(amount);
    if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
      return NextResponse.json({ ok: false, error: "Invalid amount" }, { status: 400 });
    }

    const MIN_WITHDRAW = 5;
    if (numAmount < MIN_WITHDRAW) {
      return NextResponse.json({ ok: false, error: `Minimum withdrawal is GH₵${MIN_WITHDRAW}` }, { status: 400 });
    }

    // A withdrawal must go to a real mobile-money number. Normalise once and
    // validate against the same rule the UI uses; the client-side guard is a
    // convenience — this is the authoritative rejection.
    const destination = normalizePhoneDigits(String(dest ?? ""));
    if (!isValidPhone(destination)) {
      return NextResponse.json(
        { ok: false, error: "Enter a valid destination mobile money number" },
        { status: 400 },
      );
    }

    // Fee calculation logic
    const fee = numAmount * 0.02; // 2% fee, for example
    const netAmount = numAmount - fee;

    const ref = `WDL-${randomBytes(6).toString("hex").toUpperCase()}`;

    // Atomic transaction
    const result = await db.transaction(async (tx) => {
      // Lock wallet for update
      const [lockedWallet] = await tx.select().from(wallets).where(eq(wallets.id, wallet.id)).for("update");
      if (Number(lockedWallet.balance) < numAmount) {
        throw new Error("Insufficient balance");
      }

      // Deduct balance
      await tx.update(wallets)
        .set({ balance: sql`${wallets.balance} - ${numAmount}` })
        .where(eq(wallets.id, wallet.id));

      // Create withdrawal request
      const [withdrawal] = await tx.insert(withdrawalRequests).values({
        ref,
        userId: userId,
        walletId: wallet.id,
        amount: numAmount.toFixed(2),
        fee: fee.toFixed(2),
        netAmount: netAmount.toFixed(2),
        destinationMethod: method,
        destinationDetails: { account: destination },
        status: "pending",
      }).returning();

      // Create transaction record
      await tx.insert(transactions).values({
        ref,
        walletId: wallet.id,
        type: "withdrawal",
        status: "pending",
        direction: "out",
        title: "Withdrawal Request",
        subtitle: `To ${method}`,
        amount: numAmount.toFixed(2),
      });

      return { ok: true, ref, newBalance: Number(lockedWallet.balance) - numAmount, fee, netAmount };
    });

    return NextResponse.json(result);
  } catch (err: any) {
    if (err.message === "Insufficient balance") {
      return NextResponse.json({ ok: false, error: "Insufficient balance" }, { status: 400 });
    }
    console.error("Withdrawal error:", err);
    return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
  }
}
