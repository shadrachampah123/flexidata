import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
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

/**
 * Constant-time string comparison. Hashing first keeps the comparison
 * constant-time regardless of the shared-secret length.
 */
function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Authorize a data-provider callback.
 *
 * - `DATA_API_WEBHOOK_SECRET` is mandatory in production: a missing or blank
 *   secret rejects every callback instead of allowing unauthenticated writes.
 * - When a secret is configured, a valid HMAC-SHA256 signature over the raw
 *   request body is the preferred authentication (`x-data-api-signature`,
 *   `x-webhook-signature`, `x-flexidata-signature`). The legacy
 *   plain-secret header and `Authorization: Bearer <secret>` forms are still
 *   accepted so an already-configured provider is not broken, but they are
 *   compared in constant time.
 */
function isAuthorized(req: Request, rawBody: string): boolean {
  const secret = getWebhookSecret();
  if (!secret) {
    return process.env.NODE_ENV !== "production";
  }

  const signature =
    req.headers.get("x-data-api-signature") ??
    req.headers.get("x-data-api-signature-sha256") ??
    req.headers.get("x-webhook-signature") ??
    req.headers.get("x-flexidata-signature");

  if (signature) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return safeEqual(expected, signature);
  }

  const headerSecret =
    req.headers.get("x-data-api-webhook-secret") ??
    req.headers.get("x-webhook-secret") ??
    req.headers.get("x-flexidata-webhook-secret");

  if (safeEqual(headerSecret, secret)) return true;

  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") && safeEqual(auth.slice(7), secret);
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
    // Read the raw body first so an HMAC signature can be verified over the
    // exact bytes the provider sent before any parsing/processing happens.
    const rawBody = await req.text();
    if (!isAuthorized(req, rawBody)) {
      return Response.json({ ok: false, error: "Unauthorized callback" }, { status: 401 });
    }

    const payload = JSON.parse(rawBody) as Record<string, unknown>;
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
    const isSuccess = normalized.status === "successful";
    const isFailure = normalized.status === "failed" || normalized.status === "reversed";

    let txPoints = tx.points;
    let chargedAt = tx.chargedAt;
    let fulfilledAt = tx.fulfilledAt;
    let refundedAt = tx.refundedAt;

    // Money/points intents — the same business rules this route has always
    // applied, but they are no longer computed against a stale wallet snapshot
    // and written back as absolute values (a read-modify-write that could
    // silently erase a concurrent deposit, transfer, or purchase — and whose
    // ledger flag was written AFTER the wallet in a separate statement, so a
    // failure in between let the provider's redelivery refund twice).
    //
    // Instead: ONE conditional claim on the ledger row (the WHERE clause
    // carries the exact precondition of the mutation — refunded_at IS NULL /
    // charged_at IS NULL / points = 0), and only the single caller that wins
    // the claim applies the wallet change as SQL arithmetic — all inside one
    // transaction. Concurrent duplicate deliveries therefore apply exactly
    // once, and the balance can never be computed from stale state.
    const refundWallet = isFailure && wasCharged && !wasRefunded;
    const clawbackPoints = isFailure && wasSuccessful && tx.points > 0;
    const chargeWallet = isSuccess && !wasCharged;
    const awardPoints = isSuccess && !wasSuccessful && tx.points === 0;
    const walletMutation = refundWallet || clawbackPoints || chargeWallet || awardPoints;

    if (isSuccess) {
      if (chargeWallet) chargedAt = now;
      if (awardPoints) txPoints = earnedPoints;
      fulfilledAt = now;
      refundedAt = null;
    }
    if (isFailure) {
      if (refundWallet) refundedAt = now;
      if (clawbackPoints) txPoints = 0;
      fulfilledAt = null;
    }

    // The settlement is built through `withSchemaFallback`: its capability
    // probe runs on its own connection BEFORE the transaction below opens
    // (same pattern as the deposit settle path in src/lib/deposits.ts), and a
    // schema-incompatible error downgrades the caps and re-runs the whole
    // transaction against the legacy schema — status coerced for the legacy
    // enum, gateway columns omitted.
    const buildPatch = (caps: SchemaCapabilities) => ({
      // A legacy `tx_status` enum has no "reversed" label; a refund is still a
      // non-successful outcome there, and the wallet below was already
      // credited.
      status: supportsTxStatusValue(caps, normalized.status)
        ? normalized.status
        : normalized.status === "reversed"
          ? ("failed" as const)
          : normalized.status,
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
    });

    if (walletMutation) {
      const outcome = await withSchemaFallback(async (caps) => {
        return db.transaction(async (txdb) => {
          // Claim the ledger row: the conditional UPDATE hands the row to
          // exactly one concurrent delivery of this event. Everyone else gets
          // zero rows and must not touch the wallet. The guards are the exact
          // preconditions of the mutation, so a redelivery that arrives after
          // the first one applied loses the claim.
          const guards = [
            ...(chargeWallet && hasTransactionColumn(caps, "chargedAt")
              ? [isNull(transactions.chargedAt)]
              : []),
            ...(refundWallet && hasTransactionColumn(caps, "refundedAt")
              ? [isNull(transactions.refundedAt)]
              : []),
            ...(awardPoints ? [eq(transactions.points, 0)] : []),
          ];
          const claimed = await txdb
            .update(transactions)
            .set(omitMissingGatewayColumns(caps, "transactions", buildPatch(caps)))
            .where(guards.length > 0 ? and(eq(transactions.id, tx.id), ...guards) : eq(transactions.id, tx.id))
            .returning({ id: transactions.id });

          if (!claimed[0]) {
            // Lost the race: a concurrent delivery of the same event already
            // applied the ledger patch and the wallet mutation.
            return { applied: false as const };
          }

          // Atomic wallet arithmetic on the LIVE row — never a value derived
          // from the earlier read, so a deposit/transfer/purchase that commits
          // concurrently cannot be clobbered. (The charge-on-confirmation
          // debit is deliberately not bounded by `balance >= amount`: the
          // bundle was already delivered, so the honest outcome is the same
          // debt record the route has always written — now without corrupting
          // the balance.)
          const updated = await txdb
            .update(wallets)
            .set({
              ...(refundWallet
                ? { balance: sql`${wallets.balance} + ${amount.toFixed(2)}::numeric` }
                : chargeWallet
                  ? { balance: sql`${wallets.balance} - ${amount.toFixed(2)}::numeric` }
                  : {}),
              ...(clawbackPoints
                ? { points: sql`GREATEST(0, ${wallets.points} - ${tx.points})` }
                : awardPoints
                  ? { points: sql`${wallets.points} + ${earnedPoints}` }
                  : {}),
            })
            .where(eq(wallets.id, wallet.id))
            .returning({ balance: wallets.balance, points: wallets.points });

          return {
            applied: true as const,
            balance: Number(updated[0]?.balance ?? wallet.balance),
            points: updated[0]?.points ?? wallet.points,
          };
        });
      }, "callback settlement");

      if (!outcome.applied) {
        console.info(`[callback] ${tx.ref}: settlement claim lost — a concurrent delivery already applied it`);
      }
    } else {
      // No money movement for this event (already-terminal delivery, or a
      // plain status/message sync): best-effort ledger-only write.
      await withSchemaFallback(async (caps) => {
        await db
          .update(transactions)
          .set(omitMissingGatewayColumns(caps, "transactions", buildPatch(caps)))
          .where(eq(transactions.id, tx.id));
      }, "callback reconciliation write");
    }

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
