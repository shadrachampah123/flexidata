import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { transactions, wallets } from "@/db/schema";
import { getWalletByPhone } from "@/lib/data";
import { requireAccount } from "@/lib/api-auth";
import {
  buildCompatInsert,
  getSchemaCapabilities,
  isGatewaySchemaComplete,
  TRANSACTION_INSERT_FIELDS,
} from "@/lib/schema-compat";
import { groupPhone, isValidPhone, makeRef, normalizePhoneDigits } from "@/lib/format";

export const dynamic = "force-dynamic";

type Body = { account?: string; amount?: number };

class InsufficientFundsError extends Error {
  constructor(readonly balance: number) {
    super("insufficient_funds");
    this.name = "InsufficientFundsError";
  }
}

/** Normalise a deposit/transfer amount to two decimal places once, server-side. */
function normaliseAmount(input: number): number {
  if (!Number.isFinite(input) || input < 1 || input > 5000) return NaN;
  return Math.round(input * 100) / 100;
}

export async function POST(req: Request) {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;
    const { wallet } = auth;

    const body = (await req.json()) as Body;
    const account = normalizePhoneDigits(body.account ?? "");
    const amount = normaliseAmount(Number(body.amount));

    if (!isValidPhone(account)) {
      return Response.json({ ok: false, error: "Enter a valid FlexiData wallet number" }, { status: 400 });
    }
    if (Number.isNaN(amount) || amount < 1 || amount > 5000) {
      return Response.json({ ok: false, error: "Enter an amount between GH₵ 1 and GH₵ 5,000" }, { status: 400 });
    }
    if (account === wallet.number) {
      return Response.json({ ok: false, error: "You can't transfer to your own wallet" }, { status: 400 });
    }

    // Recipient is resolved from the server-side wallet lookup by the signed-in
    // user's account; the client can never name an arbitrary wallet id.
    const recipient = await getWalletByPhone(account);
    if (!recipient) {
      return Response.json(
        { ok: false, error: "No FlexiData account found for that number. Ask them to register." },
        { status: 404 },
      );
    }

    // Schema capability is read before the transaction because the catalog
    // probe runs on its own connection and must not hold the tx connection.
    const compat = await getSchemaCapabilities().catch(() => null);
    const useCompatLedger = compat ? !isGatewaySchemaComplete(compat, "transactions") : false;

    const ref = makeRef("TR");
    const amountValue = amount.toFixed(2);

    const result = await db.transaction(async (tx) => {
      // Debit must be conditional on the current balance so concurrent
      // transfers cannot overdraft the sender. Both wallet rows are updated in
      // ascending id order to avoid deadlocks on reverse transfers.
      const walletSteps = wallet.id < recipient.id
        ? [
            { walletId: wallet.id, sender: true },
            { walletId: recipient.id, sender: false },
          ]
        : [
            { walletId: recipient.id, sender: false },
            { walletId: wallet.id, sender: true },
          ];

      let newBalance: number | null = null;

      for (const step of walletSteps) {
        if (step.sender) {
          const debited = await tx
            .update(wallets)
            .set({ balance: sql`${wallets.balance} - ${amountValue}::numeric` })
            .where(
              and(
                eq(wallets.id, wallet.id),
                sql`${wallets.balance} >= ${amountValue}::numeric`,
              ),
            )
            .returning({
              id: wallets.id,
              balance: wallets.balance,
              name: wallets.name,
              number: wallets.number,
            });

          if (debited.length === 0) {
            const current = await tx
              .select({ balance: wallets.balance })
              .from(wallets)
              .where(eq(wallets.id, wallet.id))
              .limit(1);
            throw new InsufficientFundsError(Number(current[0]?.balance ?? 0));
          }
          newBalance = Number(debited[0].balance);
        } else {
          const credited = await tx
            .update(wallets)
            .set({ balance: sql`${wallets.balance} + ${amountValue}::numeric` })
            .where(eq(wallets.id, recipient.id))
            .returning({ id: wallets.id });

          if (credited.length === 0) {
            throw new Error("Recipient wallet no longer exists");
          }
        }
      }

      const outbound: typeof transactions.$inferInsert = {
        ref,
        walletId: wallet.id,
        type: "transfer",
        status: "successful",
        direction: "out",
        title: "Wallet Transfer",
        subtitle: `To ${recipient.name} • ${groupPhone(account)}`,
        amount: amountValue,
        points: 0,
        network: null,
        recipient: account,
      };

      const inbound: typeof transactions.$inferInsert = {
        ref: `${ref}-IN`,
        walletId: recipient.id,
        type: "transfer",
        status: "successful",
        direction: "in",
        title: "Wallet Received",
        subtitle: `From ${wallet.name} • ${groupPhone(wallet.number)}`,
        amount: amountValue,
        points: 0,
        network: null,
        recipient: wallet.number,
      };

      // Ledger rows live in the SAME transaction as the balance changes: if any
      // leg fails, the whole transfer rolls back.
      if (compat && useCompatLedger) {
        await tx.execute(buildCompatInsert(compat, "transactions", TRANSACTION_INSERT_FIELDS, [outbound, inbound]));
      } else {
        await tx.insert(transactions).values([outbound, inbound]);
      }

      return { balance: newBalance };
    });

    return Response.json({ ok: true, status: "successful", ref, balance: result.balance });
  } catch (e) {
    if (e instanceof InsufficientFundsError) {
      return Response.json({ ok: false, error: "insufficient_funds", balance: e.balance }, { status: 402 });
    }
    console.error("transfer error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
