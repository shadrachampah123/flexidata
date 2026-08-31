import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { transactions, wallets } from "@/db/schema";
import {
  extractCallbackReference,
  getStoredProviderFloatBalance,
  getWebhookSecret,
  normalizeCallbackStatus,
  upsertProviderFloatBalance,
} from "@/lib/data-gateway";
import { POINTS_RATE } from "@/lib/constants";
import { groupPhone } from "@/lib/format";
import {
  hasAllTransactionColumns,
  hasTransactionColumn,
  omitMissingGatewayColumns,
  supportsTxStatusValue,
  withSchemaFallback,
  type SchemaCapabilities,
} from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

/**
 * Fields the callback needs from the fulfillment ledger. On a database that has
 * not been migrated for the data gateway these are absent, so they are read as
 * `null` and skipped on write.
 */
const LEDGER_FIELDS = ["provider", "providerReference", "chargedAt", "fulfilledAt", "refundedAt"] as const;

const CALLBACK_BASE_SELECT = {
  id: transactions.id,
  ref: transactions.ref,
  walletId: transactions.walletId,
  type: transactions.type,
  status: transactions.status,
  network: transactions.network,
  recipient: transactions.recipient,
  subtitle: transactions.subtitle,
  amount: transactions.amount,
  points: transactions.points,
};

const CALLBACK_LEDGER_SELECT = {
  provider: transactions.provider,
  providerReference: transactions.providerReference,
  chargedAt: transactions.chargedAt,
  fulfilledAt: transactions.fulfilledAt,
  refundedAt: transactions.refundedAt,
};

type CallbackTx = {
  id: number;
  ref: string;
  walletId: number;
  type:
    | "data"
    | "airtime"
    | "conversion"
    | "deposit"
    | "transfer"
    | "redemption"
    | "referral";
  status: "successful" | "pending" | "failed" | "reversed";
  network: string | null;
  recipient: string | null;
  subtitle: string;
  amount: string;
  points: number;
  provider: string | null;
  providerReference: string | null;
  chargedAt: Date | null;
  fulfilledAt: Date | null;
  refundedAt: Date | null;
};

function clampText(value: string | null | undefined, max = 240): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function buildSubtitle(
  recipient: string | null,
  status: string,
  providerMessage: string | null,
): string {
  const base = recipient ? `To ${groupPhone(recipient)}` : "Recipient pending";
  const hint = clampText(providerMessage, 90);

  if (status === "failed") return `${base} • Not charged`;
  if (status === "reversed") return `${base} • Refunded`;
  if (hint) return clampText(`${base} • ${hint}`, 200) ?? base;
  return base;
}

function isAuthorized(req: Request): boolean {
  const secret = getWebhookSecret();
  if (!secret) return true;

  const headerSecret =
    req.headers.get("x-data-api-webhook-secret") ??
    req.headers.get("x-webhook-secret") ??
    req.headers.get("x-flexidata-webhook-secret");

  if (headerSecret && headerSecret === secret) return true;

  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;

  return false;
}

/**
 * Resolve the transaction a callback belongs to. `provider_reference` is only
 * matched when the column exists, and on a legacy schema the ledger fields fall
 * back to `null` instead of breaking the reconciliation.
 */
async function findCallbackTransaction(
  reference: string | null,
  providerReference: string | null,
  compat: SchemaCapabilities,
): Promise<CallbackTx | null> {
  const canMatchProviderRef = hasTransactionColumn(compat, "providerReference") && Boolean(providerReference);

  const where =
    reference && providerReference && canMatchProviderRef
      ? or(eq(transactions.ref, reference), eq(transactions.providerReference, providerReference))
      : reference
        ? eq(transactions.ref, reference)
        : canMatchProviderRef
          ? eq(transactions.providerReference, providerReference!)
          : null;

  if (!where) return null;

  if (hasAllTransactionColumns(compat, [...LEDGER_FIELDS])) {
    const rows = await db
      .select({ ...CALLBACK_BASE_SELECT, ...CALLBACK_LEDGER_SELECT })
      .from(transactions)
      .where(where)
      .limit(1);
    return (rows[0] as CallbackTx) ?? null;
  }

  const rows = await db.select(CALLBACK_BASE_SELECT).from(transactions).where(where).limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    ...row,
    provider: null,
    providerReference: null,
    chargedAt: null,
    fulfilledAt: null,
    refundedAt: null,
  };
}

export async function POST(req: Request) {
  try {
    if (!isAuthorized(req)) {
      return Response.json({ ok: false, error: "Unauthorized callback" }, { status: 401 });
    }

    const payload = (await req.json()) as Record<string, unknown>;
    const reference = extractCallbackReference(payload);
    const normalized = normalizeCallbackStatus(payload);

    if (!reference && !normalized.providerReference) {
      return Response.json({ ok: false, error: "Missing callback reference" }, { status: 400 });
    }

    const tx = await withSchemaFallback(
      (compat) => findCallbackTransaction(reference, normalized.providerReference, compat),
      "callback transaction lookup",
    );

    if (!tx) {
      return Response.json({ ok: false, error: "Transaction not found" }, { status: 404 });
    }

    if (tx.type !== "data") {
      return Response.json({ ok: false, error: "Only data callbacks are supported" }, { status: 400 });
    }

    const walletRows = await db.select().from(wallets).where(eq(wallets.id, tx.walletId)).limit(1);
    const wallet = walletRows[0];
    if (!wallet) {
      return Response.json({ ok: false, error: "Wallet not found" }, { status: 404 });
    }

    const now = new Date();
    const amount = Number(tx.amount);
    const wasCharged = Boolean(tx.chargedAt);
    const wasRefunded = Boolean(tx.refundedAt);
    const wasSuccessful = tx.status === "successful";
    const earnedPoints = Math.max(1, Math.round(amount * POINTS_RATE));

    let balance = Number(wallet.balance);
    let points = wallet.points;
    let txPoints = tx.points;
    let chargedAt = tx.chargedAt;
    let fulfilledAt = tx.fulfilledAt;
    let refundedAt = tx.refundedAt;

    if (normalized.status === "successful") {
      if (!wasCharged) {
        balance -= amount;
        chargedAt = now;
      }
      if (!wasSuccessful && tx.points === 0) {
        points += earnedPoints;
        txPoints = earnedPoints;
      }
      fulfilledAt = now;
      refundedAt = null;
    }

    if (normalized.status === "failed" || normalized.status === "reversed") {
      if (wasCharged && !wasRefunded) {
        balance += amount;
        refundedAt = now;
      }
      if (wasSuccessful && tx.points > 0) {
        points = Math.max(0, points - tx.points);
        txPoints = 0;
      }
      fulfilledAt = null;
    }

    if (balance !== Number(wallet.balance) || points !== wallet.points) {
      await db
        .update(wallets)
        .set({
          balance: balance.toFixed(2),
          points,
        })
        .where(eq(wallets.id, wallet.id));
    }

    await withSchemaFallback(async (compat) => {
      // A legacy `tx_status` enum has no "reversed" label; a refund is still a
      // non-successful outcome there, and the wallet above was already credited.
      const status = supportsTxStatusValue(compat, normalized.status)
        ? normalized.status
        : normalized.status === "reversed"
          ? "failed"
          : normalized.status;

      const patch = {
        status,
        fulfillmentStatus: normalized.fulfillmentStatus,
        subtitle: buildSubtitle(tx.recipient, normalized.status, normalized.providerMessage),
        points: txPoints,
        providerReference: normalized.providerReference ?? tx.providerReference,
        providerStatus: normalized.providerStatus,
        providerMessage: clampText(normalized.providerMessage),
        fulfilledAt,
        refundedAt,
        chargedAt,
        lastProviderSyncAt: now,
        providerResponse: payload,
      };

      await db
        .update(transactions)
        .set(omitMissingGatewayColumns(compat, "transactions", patch))
        .where(eq(transactions.id, tx.id));
    }, "callback reconciliation write");

    if (tx.network) {
      if (normalized.floatBalance != null) {
        const stored = await getStoredProviderFloatBalance(tx.network);
        const reservedBalance =
          normalized.status === "pending"
            ? stored?.reservedBalance ?? amount
            : Math.max(0, (stored?.reservedBalance ?? 0) - (tx.status === "pending" ? amount : 0));

        await upsertProviderFloatBalance({
          providerCode: tx.provider ?? undefined,
          network: tx.network,
          availableBalance: normalized.floatBalance,
          reservedBalance,
          lowBalanceThreshold: stored?.lowBalanceThreshold ?? 0,
          lastReference: tx.ref,
          lastStatus: normalized.providerStatus ?? normalized.status,
          notes: normalized.providerMessage,
          lastSyncedAt: now,
        });
      } else {
        const stored = await getStoredProviderFloatBalance(tx.network);
        if (stored) {
          let availableBalance = stored.availableBalance;
          let reservedBalance = stored.reservedBalance;

          if (tx.status === "pending" && normalized.status === "successful") {
            reservedBalance = Math.max(0, reservedBalance - amount);
          }
          if (tx.status === "pending" && (normalized.status === "failed" || normalized.status === "reversed")) {
            reservedBalance = Math.max(0, reservedBalance - amount);
            availableBalance += amount;
          }
          if (tx.status === "successful" && normalized.status === "reversed") {
            availableBalance += amount;
          }
          if (!wasCharged && normalized.status === "successful") {
            availableBalance = Math.max(0, availableBalance - amount);
          }

          await upsertProviderFloatBalance({
            providerCode: tx.provider ?? undefined,
            network: tx.network,
            availableBalance,
            reservedBalance,
            lowBalanceThreshold: stored.lowBalanceThreshold,
            lastReference: tx.ref,
            lastStatus: normalized.providerStatus ?? normalized.status,
            notes: normalized.providerMessage,
            lastSyncedAt: stored.lastSyncedAt,
          });
        }
      }
    }

    return Response.json({ ok: true, ref: tx.ref, status: normalized.status });
  } catch (error) {
    console.error("purchase callback error", error);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
