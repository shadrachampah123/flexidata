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

export const dynamic = "force-dynamic";

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

    let rows;
    if (reference && normalized.providerReference) {
      rows = await db
        .select()
        .from(transactions)
        .where(or(eq(transactions.ref, reference), eq(transactions.providerReference, normalized.providerReference)))
        .limit(1);
    } else if (reference) {
      rows = await db.select().from(transactions).where(eq(transactions.ref, reference)).limit(1);
    } else if (normalized.providerReference) {
      rows = await db
        .select()
        .from(transactions)
        .where(eq(transactions.providerReference, normalized.providerReference))
        .limit(1);
    } else {
      return Response.json({ ok: false, error: "Missing callback reference" }, { status: 400 });
    }

    const tx = rows[0];
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

    await db
      .update(transactions)
      .set({
        status: normalized.status,
        fulfillmentStatus: normalized.fulfillmentStatus,
        subtitle: buildSubtitle(tx.recipient, normalized.status, normalized.providerMessage),
        points: txPoints,
        providerReference: normalized.providerReference ?? tx.providerReference,
        providerStatus: normalized.providerStatus ?? tx.providerStatus,
        providerMessage: clampText(normalized.providerMessage),
        fulfilledAt,
        refundedAt,
        chargedAt,
        lastProviderSyncAt: now,
        providerResponse: payload,
      })
      .where(eq(transactions.id, tx.id));

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
