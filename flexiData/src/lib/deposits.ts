import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { depositRequests, transactions, wallets } from "@/db/schema";
import { PAYMENT_METHODS, initPayment, paymentsProvider, type PaymentMethod } from "@/lib/payments";
import { paystackVerifyTransaction, PAYSTACK_CURRENCY, PaystackConfigError } from "@/lib/paystack";
import { makeRef } from "@/lib/format";
import { DEPOSIT_MAX_GHS, DEPOSIT_MIN_GHS } from "@/lib/constants";
import {
  buildCompatInsert,
  getSchemaCapabilities,
  isGatewaySchemaComplete,
  TRANSACTION_INSERT_FIELDS,
} from "@/lib/schema-compat";

/**
 * Wallet deposit service — the money-safe core behind /api/wallet/fund,
 * /api/payments/verify and the deposit branch of the Paystack webhook.
 *
 * It deliberately mirrors the proven rules in `src/lib/checkout.ts`:
 *
 *  1. The amount is ALWAYS resolved server-side from the validated request
 *     (integer pesewas stored on the row before Paystack is ever called).
 *  2. A deposit is only ever marked paid after Paystack's verify API
 *     (server → Paystack, secret key) confirms status=success AND the exact
 *     reference AND the exact integer amount in pesewas AND the currency.
 *     Webhook payloads and browser redirects are untrusted hints.
 *  3. Settlement happens exactly once: a single conditional UPDATE
 *     (`pending/abandoned/failed` → `successful`) that only one concurrent
 *     caller can win, performed inside one database transaction that also
 *     increments the wallet balance (SQL `balance = balance + amount`, never a
 *     read-modify-write in Node) and inserts the ledger row. Duplicate
 *     webhooks / verify calls / polls therefore can never double-credit.
 *  4. A failed / abandoned / mismatched charge is parked and never credited.
 *
 * Mock mode (`PAYMENTS_PROVIDER != paystack`) keeps the instant-credit dev
 * experience, but routes that credit through the SAME atomic settle path.
 *
 * PRODUCTION LOCK (defence in depth, enforced at every decision point below):
 * in a production runtime (`NODE_ENV === "production"`) a deposit whose
 * provider is not `paystack` can NEVER credit a wallet — not through the fund
 * route, not through /api/payments/verify, not through the webhook, and not
 * through `settleAtomic` itself (the single choke point where money moves).
 * `paymentsProvider()` already refuses to resolve to `mock` in production;
 * these checks guarantee the same outcome even if a future caller resolves the
 * provider some other way. Production deposits are settled exclusively by
 * Paystack's server-side verification (exact reference + pesewa amount +
 * currency).
 */

export class DepositInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepositInputError";
  }
}

export type DepositRow = typeof depositRequests.$inferSelect;

export type DepositSummary = {
  ref: string;
  status: DepositRow["status"];
  amount: number;
  currency: string;
  method: string;
  provider: string;
  paidAt: string | null;
  initiatedAt: string;
  completedAt: string | null;
};

const MIN_DEPOSIT_GHS = DEPOSIT_MIN_GHS;
const MAX_DEPOSIT_GHS = DEPOSIT_MAX_GHS;

/**
 * True in a production runtime, where wallet deposits may ONLY be settled by
 * verified Paystack charges. Every mock/demo settlement path checks this
 * independently so no refactoring or alternative caller can re-enable
 * simulated wallet credit in production.
 */
function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

function clampText(value: string | null | undefined, max = 240): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function toDepositSummary(deposit: DepositRow): DepositSummary {
  const method = PAYMENT_METHODS[deposit.method as PaymentMethod]?.label ?? "Card";
  return {
    ref: deposit.ref,
    status: deposit.status,
    amount: Number(deposit.amount),
    currency: deposit.currency ?? "GHS",
    method,
    provider: deposit.provider,
    paidAt: deposit.paidAt?.toISOString() ?? null,
    initiatedAt: deposit.initiatedAt.toISOString(),
    completedAt: deposit.completedAt?.toISOString() ?? null,
  };
}

export async function getDeposit(ref: string): Promise<DepositRow | null> {
  const rows = await db.select().from(depositRequests).where(eq(depositRequests.ref, ref)).limit(1);
  return rows[0] ?? null;
}

/**
 * Step 1: validate and record a deposit attempt BEFORE talking to Paystack,
 * then initialise the charge and hand back the redirect URL.
 *
 * In mock mode the deposit is settled instantly (via the same atomic path);
 * in paystack mode the row stays `pending` until `reconcileDeposit` confirms
 * the charge from the verify API / webhook.
 */
export async function createDepositRequest(params: {
  walletId: number;
  walletNumber: string;
  email: string;
  method: string;
  amountGhs: number;
  /** Mobile-money number typed by the customer (Paystack metadata hint only). */
  momoNumber?: string | null;
  /** Origin of the API request — used for the Paystack callback URL fallback. */
  requestOrigin?: string | null;
}): Promise<
  | { status: "pending"; ref: string; authorizationUrl: string; provider: string }
  | { status: "successful"; ref: string; balance: number; methodLabel: string; provider: string }
> {
  const method = params.method as PaymentMethod;
  const conf = PAYMENT_METHODS[method];
  if (!conf) throw new DepositInputError("Choose a payment method.");

  const amount = Number(params.amountGhs);
  if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_GHS || amount > MAX_DEPOSIT_GHS) {
    throw new DepositInputError(`Amount must be between GH₵ ${MIN_DEPOSIT_GHS} and GH₵ ${MAX_DEPOSIT_GHS.toLocaleString()}`);
  }
  const amountSubunits = Math.round(amount * 100);
  if (!Number.isInteger(amountSubunits) || amountSubunits <= 0) {
    throw new DepositInputError("Enter a valid amount.");
  }

  const provider = paymentsProvider();
  const ref = makeRef("DP");

  // Production lock: the instant mock settlement below must be unreachable in
  // a production runtime even if the provider was resolved by something other
  // than `paymentsProvider()`. Throwing the config error keeps the fund route's
  // existing generic 503 "paystack_unconfigured" response — no details, no
  // credit.
  if (isProductionRuntime() && provider !== "paystack") {
    console.error(
      `[deposit] blocked a non-Paystack (${provider}) wallet deposit in production — demo/mock funding is disabled.`,
    );
    throw new PaystackConfigError(
      "Wallet funding is locked to verified Paystack payments in production; demo deposits are disabled.",
    );
  }

  // Record the attempt up front so a Paystack redirect can never be orphaned.
  await db.insert(depositRequests).values({
    ref,
    walletId: params.walletId,
    provider,
    method,
    amount: amount.toFixed(2),
    amountSubunits,
    currency: PAYSTACK_CURRENCY,
    status: "pending",
  });

  // Mock mode: no external charge — settle instantly through the atomic path.
  if (provider !== "paystack") {
    const result = await reconcileDeposit(ref);
    const balance = await getWalletBalance(params.walletId);
    return {
      status: "successful",
      ref,
      balance,
      methodLabel: result?.method ?? conf.label,
      provider,
    };
  }

  // --- Paystack: initialise the hosted checkout (secret key stays server-side).
  try {
    const payment = await initPayment({
      ref,
      amountGhs: amount,
      email: params.email,
      method,
      phone: params.walletNumber,
      momoNumber: params.momoNumber,
      requestOrigin: params.requestOrigin,
    });

    if (payment.status === "completed") {
      // Defensive: a paystack-configured provider should always return a
      // redirect URL, but settle atomically if it ever reports completion.
      const result = await reconcileDeposit(ref);
      return {
        status: "successful",
        ref,
        balance: await getWalletBalance(params.walletId),
        methodLabel: result?.method ?? conf.label,
        provider,
      };
    }

    await db
      .update(depositRequests)
      .set({ providerReference: payment.providerRef, updatedAt: new Date() })
      .where(eq(depositRequests.ref, ref));

    return { status: "pending", ref, authorizationUrl: payment.authorizationUrl, provider };
  } catch (error) {
    // Initialization never reached checkout: park the attempt as failed.
    await markDepositFailed(ref, error instanceof Error ? error.message : "Payment initialization failed").catch(
      () => undefined,
    );
    throw error;
  }
}

async function getWalletBalance(walletId: number): Promise<number> {
  const rows = await db
    .select({ balance: wallets.balance })
    .from(wallets)
    .where(eq(wallets.id, walletId))
    .limit(1);
  return Number(rows[0]?.balance ?? 0);
}

async function markDepositFailed(ref: string, message: string): Promise<void> {
  const now = new Date();
  await db
    .update(depositRequests)
    .set({
      status: "failed",
      completedAt: now,
      verifiedAt: now,
      paystackGatewayResponse: clampText(message),
      updatedAt: now,
    })
    .where(and(eq(depositRequests.ref, ref), eq(depositRequests.status, "pending")));
}

/**
 * Steps 2–3: confirm the charge directly with Paystack (the only source of
 * truth), then settle the deposit idempotently. Safe to call any number of
 * times from the webhook, the post-redirect verify call and polling —
 * duplicates are absorbed by the conditional-UPDATE claim inside one
 * transaction.
 */
export async function reconcileDeposit(ref: string): Promise<DepositSummary | null> {
  const deposit = await getDeposit(ref);
  if (!deposit) return null;

  // Terminal settled state never changes again.
  if (deposit.status === "successful") {
    return toDepositSummary(deposit);
  }

  // PRODUCTION LOCK: a deposit that was not created through Paystack can never
  // be settled in a production runtime — there is no real charge behind it.
  // Park it as failed (auditable, visible to the customer as "not completed")
  // instead of taking the mock instant-settlement branch below. This is checked
  // before `paymentsProvider()` so a misconfigured production runtime (mock
  // provider or missing key) fails this deposit explicitly rather than
  // erroring or — worse — settling.
  if (isProductionRuntime() && deposit.provider !== "paystack") {
    console.error(
      `[deposit] refused to settle non-Paystack (${deposit.provider}) deposit ${deposit.ref} in production — ` +
        "demo/mock deposits cannot credit wallets.",
    );
    const now = new Date();
    await db
      .update(depositRequests)
      .set({
        status: "failed",
        completedAt: now,
        verifiedAt: now,
        paystackGatewayResponse: clampText(
          "Not settled: demo deposits are disabled in production. Wallet was not credited.",
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(depositRequests.ref, deposit.ref),
          inArray(depositRequests.status, ["pending", "abandoned", "failed"]),
        ),
      );
    return toDepositSummary((await getDeposit(ref)) ?? deposit);
  }

  const provider = deposit.provider === "paystack" ? "paystack" : paymentsProvider();

  // Mock deposits settle immediately: there is no external charge to verify.
  if (provider !== "paystack") {
    return settleAtomic(deposit, {
      paystackTransactionId: deposit.providerReference ?? `mock-${deposit.ref}`,
      paystackChannel: null,
      paystackGatewayResponse: "Instant mock settlement",
      paidAt: deposit.initiatedAt ?? new Date(),
    });
  }

  // Ask Paystack — webhook/redirect payloads are never trusted.
  const verification = await paystackVerifyTransaction(ref);
  const now = new Date();

  if (verification.status === "success") {
    const referenceOk = (verification.reference ?? ref) === deposit.ref;
    const amountOk =
      verification.amountSubunits != null && verification.amountSubunits === deposit.amountSubunits;
    const currencyOk = (verification.currency ?? PAYSTACK_CURRENCY).toUpperCase() === (deposit.currency ?? "GHS").toUpperCase();

    if (!referenceOk || !amountOk || !currencyOk) {
      // A "successful" charge that does not match what we recorded is NEVER
      // credited. Park it for manual review. Logs carry amounts only.
      console.error(
        `[deposit] verification mismatch for ${deposit.ref}: ` +
          `amount ${verification.amountSubunits}/${deposit.amountSubunits}, ` +
          `currency ${verification.currency}/${deposit.currency}, referenceOk=${referenceOk}`,
      );
      await db
        .update(depositRequests)
        .set({
          status: "failed",
          completedAt: now,
          verifiedAt: now,
          paystackTransactionId: verification.transactionId,
          paystackGatewayResponse: clampText(
            "Payment did not match this deposit (amount/currency/reference) and was not credited. Contact support.",
          ),
          updatedAt: now,
        })
        .where(and(eq(depositRequests.ref, ref), inArray(depositRequests.status, ["pending", "abandoned", "failed"])));
      return toDepositSummary((await getDeposit(ref)) ?? deposit);
    }

    return settleAtomic(deposit, {
      paystackTransactionId: verification.transactionId,
      paystackChannel: verification.channel,
      paystackGatewayResponse: verification.gatewayResponse ?? "Approved",
      paidAt: verification.paidAt ?? now,
    });
  }

  if (verification.status === "failed" || verification.status === "reversed") {
    await db
      .update(depositRequests)
      .set({
        status: "failed",
        completedAt: now,
        verifiedAt: now,
        paystackTransactionId: verification.transactionId,
        paystackGatewayResponse: clampText(verification.gatewayResponse ?? verification.rawStatus),
        updatedAt: now,
      })
      .where(and(eq(depositRequests.ref, ref), inArray(depositRequests.status, ["pending", "abandoned"])));
    return toDepositSummary((await getDeposit(ref)) ?? deposit);
  }

  if (verification.status === "abandoned") {
    await db
      .update(depositRequests)
      .set({
        status: "abandoned",
        verifiedAt: now,
        paystackGatewayResponse: clampText(verification.gatewayResponse ?? "Checkout abandoned"),
        updatedAt: now,
      })
      .where(and(eq(depositRequests.ref, ref), eq(depositRequests.status, "pending")));
    return toDepositSummary((await getDeposit(ref)) ?? deposit);
  }

  // Still pending at Paystack — nothing changes yet.
  return toDepositSummary(deposit);
}

/**
 * The idempotency lock + money movement, all in ONE database transaction:
 *
 *   1. Conditional UPDATE claims the deposit (`pending/abandoned/failed` →
 *      `successful`) and `.returning()` gives the row only to the single
 *      caller that won the race. Everyone else gets zero rows and returns
 *      without touching the balance or ledger.
 *   2. The winner increments the wallet balance with SQL arithmetic (so the
 *      increment is atomic against concurrent transfers/purchases) and inserts
 *      the ledger row in the SAME transaction — either both commit or neither.
 */
async function settleAtomic(
  deposit: DepositRow,
  audit: {
    paystackTransactionId: string | null;
    paystackChannel: string | null;
    paystackGatewayResponse: string | null;
    paidAt: Date;
  },
): Promise<DepositSummary> {
  // THE money-movement choke point. No deposit that Paystack did not take real
  // money for can ever credit a wallet in a production runtime — regardless of
  // which route, webhook or future caller asked for settlement.
  if (isProductionRuntime() && deposit.provider !== "paystack") {
    throw new PaystackConfigError(
      "Mock settlement is disabled in production; wallets can only be credited from verified Paystack payments.",
    );
  }

  const methodConf = PAYMENT_METHODS[deposit.method as PaymentMethod];
  const methodLabel = methodConf?.label ?? "Card";
  const amount = Number(deposit.amount);
  const now = new Date();
  // The ledger row is what the customer sees in /history, so it names the
  // gateway that actually took the money. For Paystack deposits it also carries
  // the Paystack reference (we hand Paystack our own ref, so `providerReference`
  // is the reference shown in the Paystack dashboard). Mock deposits keep the
  // existing "method • wallet number" wording.
  const viaPaystack = deposit.provider === "paystack";
  const paystackReference = deposit.providerReference ?? deposit.ref;

  // Which `transactions` columns this database actually has, read BEFORE the
  // transaction opens: the probe queries information_schema on its own
  // connection, and running it while holding the transaction's connection could
  // stall a small pool.
  //
  // This is money-critical. Drizzle's `insert` names EVERY column of the table
  // definition, so on a database whose `transactions` table predates the
  // data-gateway migration a plain insert dies with
  // `column "fulfillment_status" does not exist` — *after* Paystack has already
  // taken the customer's money. Every other ledger writer avoids that through
  // `insertTransactionRow` (src/lib/data.ts); this one must stay inside the
  // transaction that guards the balance, so it uses the same compatibility
  // helpers with the transaction's own executor.
  const compat = await getSchemaCapabilities().catch(() => null);
  const ledgerNeedsCompat = compat ? !isGatewaySchemaComplete(compat, "transactions") : false;

  await db.transaction(async (tx) => {
    // Claim the deposit atomically. Only one concurrent caller can win.
    const claimed = await tx
      .update(depositRequests)
      .set({
        status: "successful",
        completedAt: now,
        paidAt: audit.paidAt,
        verifiedAt: now,
        paystackTransactionId: audit.paystackTransactionId,
        paystackChannel: audit.paystackChannel,
        paystackGatewayResponse: clampText(audit.paystackGatewayResponse),
        updatedAt: now,
      })
      .where(
        and(
          eq(depositRequests.ref, deposit.ref),
          // A failed/abandoned attempt CAN still become successful (customer
          // retried inside the same Paystack checkout); a settled deposit can
          // never be claimed twice.
          inArray(depositRequests.status, ["pending", "abandoned", "failed"]),
        ),
      )
      .returning({ id: depositRequests.id, walletId: depositRequests.walletId, ref: depositRequests.ref });

    const winner = claimed[0];
    if (!winner) {
      // Lost the race (or already settled): no balance/ledger change.
      return { credited: false as const };
    }

    // Atomic balance increment — never a read-modify-write in application code.
    const updatedWallet = await tx
      .update(wallets)
      .set({ balance: sql`${wallets.balance} + ${amount.toFixed(2)}::numeric` })
      .where(eq(wallets.id, winner.walletId))
      .returning({ number: wallets.number });

    const walletNumber = updatedWallet[0]?.number ?? "";

    // Ledger row in the SAME transaction as the balance increment: either both
    // commit or neither does, so a wallet can never be credited without a
    // history row (or the other way round).
    const ledgerRow: typeof transactions.$inferInsert = {
      ref: winner.ref,
      walletId: winner.walletId,
      type: "deposit",
      status: "successful",
      direction: "in",
      title: "Wallet Top-up",
      subtitle: viaPaystack
        ? `Paystack • ${methodLabel} • ${paystackReference}`
        : `${methodLabel} • ${walletNumber}`,
      amount: amount.toFixed(2),
      points: 0,
      network: methodConf?.network ?? null,
      recipient: null,
      provider: deposit.provider,
      providerReference: audit.paystackTransactionId,
      chargedAt: audit.paidAt,
    };

    if (compat && ledgerNeedsCompat) {
      // Pre-gateway database: name only the columns that exist. The deposit is
      // still credited (the columns we skip are gateway-fulfillment fields that
      // a wallet top-up does not use anyway).
      await tx.execute(
        buildCompatInsert(compat, "transactions", TRANSACTION_INSERT_FIELDS, [ledgerRow]),
      );
    } else {
      await tx.insert(transactions).values(ledgerRow);
    }

    return { credited: true as const };
  });

  const fresh = (await getDeposit(deposit.ref)) ?? deposit;
  return toDepositSummary(fresh);
}
