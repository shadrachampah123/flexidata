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
import { groupPhone, makeRef } from "@/lib/format";
import { parseCedisAmount, pesewasToCedisString } from "@/lib/money";
import { normalizeGhanaMobileStrict } from "@/lib/ghana-mobile";

export const dynamic = "force-dynamic";

/** The ONLY keys this route accepts — anything else is refused, never ignored. */
const TRANSFER_REQUEST_KEYS = new Set(["account", "amount"]);

/** Transfer limits in integer pesewas (GH₵1 – GH₵5,000). */
const MIN_TRANSFER_PESEWAS = 100;
const MAX_TRANSFER_PESEWAS = 500_000;

class InsufficientFundsError extends Error {
  constructor(readonly balance: number) {
    super("insufficient_funds");
    this.name = "InsufficientFundsError";
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;
    const { wallet } = auth;

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
    }
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
    }
    const body = rawBody as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      // The sender is the signed-in account — never a client-supplied wallet
      // id — and the recipient is resolved server-side from the account
      // number. Smuggled identity/authorization fields are refused outright.
      if (!TRANSFER_REQUEST_KEYS.has(key)) {
        return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
      }
    }

    // Strict destination: no silent truncation, no guessing. Any valid Ghana
    // mobile prefix is accepted here (the recipient only needs a registered
    // wallet — unlike withdrawals, transfers are not network-restricted), and
    // an unregistered number then fails closed with a 404 below.
    const normalized = normalizeGhanaMobileStrict(body.account);
    if (!normalized.ok) {
      return Response.json({ ok: false, error: "Enter a valid FlexiData wallet number" }, { status: 400 });
    }
    const account = normalized.msisdn10;

    // Exact amount: parsed strictly into integer pesewas (never float math),
    // so `10.25` transfers exactly GH₵10.25 and `10.255` is refused rather
    // than rounded.
    const parsed = parseCedisAmount(body.amount);
    if (!parsed.ok || parsed.pesewas < MIN_TRANSFER_PESEWAS || parsed.pesewas > MAX_TRANSFER_PESEWAS) {
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
    const amountValue = pesewasToCedisString(parsed.pesewas);

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

    return Response.json(
      { ok: true, status: "successful", ref, balance: result.balance },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (e) {
    if (e instanceof InsufficientFundsError) {
      return Response.json({ ok: false, error: "insufficient_funds", balance: e.balance }, { status: 402 });
    }
    console.error("transfer error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
