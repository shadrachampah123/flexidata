import { PurchaseLifecycle, PurchaseConflict, PurchaseFundsError } from "@/lib/purchase-lifecycle";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bundlePlans, transactions, wallets } from "@/db/schema";
import { insertTransactionRow } from "@/lib/data";
import { requireAccount } from "@/lib/api-auth";
import { creditReferralReward } from "@/lib/referrals";
import {
  getDataProviderCode,
  isTechlinkProviderCode,
  DataProviderConfigError,
  DataProviderFloatError,
  DataProviderRequestError,
  assertDataProviderRuntimeSafe,
  deriveProviderProductCode,
  ensureProviderFloatCapacity,
  getStoredProviderFloatBalance,
  projectProviderFloatUsage,
  submitDataBundleOrder,
  upsertProviderFloatBalance,
} from "@/lib/data-gateway";
import { estimateDeliverySeconds } from "@/lib/fulfillment";
import { fetchTechlinkBundle, TechlinkApiError, TechlinkCatalogueError, TechlinkConfigurationError } from "@/lib/techlink";
import {
  BUNDLE_PLAN_INSERT_FIELDS,
  buildCompatInsert,
  hasBundlePlanColumn,
  withSchemaFallback,
  type SchemaCapabilities,
} from "@/lib/schema-compat";
import { AIRTIME_DISCOUNT, POINTS_RATE } from "@/lib/constants";
import { groupPhone, isValidPhone, makeRef } from "@/lib/format";

export const dynamic = "force-dynamic";

type Body = {
  kind?: "data" | "airtime";
  network?: string;
  category?: string;
  planLabel?: string;
  amount?: number;
  recipient?: string;
  /** Exact ID returned by the authenticated live provider catalogue. */
  providerProductCode?: string;
};

function rollLocalStatus(): "successful" | "pending" | "failed" {
  const r = Math.random();
  if (r < 0.88) return "successful";
  if (r < 0.96) return "pending";
  return "failed";
}

type FoundPlan = {
  id: number;
  network: string;
  category: string;
  label: string;
  price: string;
  providerProductCode: string;
};

/**
 * Generic legacy providers may use the existing derived fallback. Techlink is
 * different: the exact ID and price must be re-read from the authenticated
 * catalogue immediately before a purchase, so no cached seeded row can act as
 * a supplier mapping.
 */
async function findBundlePlan(
  network: string,
  category: string,
  label: string,
  recipient: string,
  requestedProviderProductCode: string | undefined,
  compat: SchemaCapabilities,
): Promise<FoundPlan | null> {
  if (isTechlinkProviderCode(getDataProviderCode())) {
    const bundleId = requestedProviderProductCode?.trim();
    if (!bundleId) return null;
    const bundle = await fetchTechlinkBundle(network as "MTN" | "TELECEL", recipient, bundleId);
    return {
      id: 0,
      network,
      category: "techlink",
      label: bundle.name,
      price: bundle.price.toFixed(2),
      providerProductCode: bundle.id,
    };
  }
  const where = and(
    eq(bundlePlans.network, network),
    eq(bundlePlans.category, category),
    eq(bundlePlans.label, label),
  );

  if (hasBundlePlanColumn(compat, "providerProductCode")) {
    const rows = await db
      .select({
        id: bundlePlans.id,
        network: bundlePlans.network,
        category: bundlePlans.category,
        label: bundlePlans.label,
        price: bundlePlans.price,
        providerProductCode: bundlePlans.providerProductCode,
      })
      .from(bundlePlans)
      .where(where)
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    const providerProductCode = row.providerProductCode?.trim() || deriveProviderProductCode(network, category, label);
    return { ...row, providerProductCode };
  }

  const rows = await db
    .select({
      id: bundlePlans.id,
      network: bundlePlans.network,
      category: bundlePlans.category,
      label: bundlePlans.label,
      price: bundlePlans.price,
    })
    .from(bundlePlans)
    .where(where)
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return { ...row, providerProductCode: deriveProviderProductCode(network, category, label) };
}

function clampText(value: string | null | undefined, max = 200): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export async function POST(req: Request) {
  try {
    // Body parsing happens before authentication solely so a DATA purchase can
    // run the side-effect-free provider preflight first (the same posture as
    // POST /api/wallet/fund). Nothing is written, debited, or looked up on this
    // path; authentication still precedes every DB/money operation below.
    const body = (await req.json().catch(() => ({}))) as Body;
    const { kind, network, recipient } = body;

    // FAIL-CLOSED PRODUCTION LOCK — before authentication, wallet lookup,
    // wallet debit, float sync, or any provider call. A production deployment
    // configured with the mock provider (or no provider, which defaults to
    // mock, or an incomplete real provider) must never start a data purchase.
    if (kind === "data") {
      assertDataProviderRuntimeSafe();
    }

    // Authenticate before the money-moving logic — unauthenticated callers must
    // never reach it or receive anything but a clean 401.
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;

    if (!network || (network !== "MTN" && network !== "TELECEL")) {
      return Response.json({ ok: false, error: "Choose a network" }, { status: 400 });
    }
    if (!recipient || !isValidPhone(recipient)) {
      return Response.json({ ok: false, error: "Enter a valid recipient number" }, { status: 400 });
    }

    const wallet = auth.wallet;
    const balance = Number(wallet.balance);
    const ref = makeRef();

    let cost = 0;
    let title = "";
    let subtitle = `To ${groupPhone(recipient)}`;

    if (kind === "data") {
      const plan = await withSchemaFallback(
        (compat) => findBundlePlan(
          network,
          body.category ?? "",
          body.planLabel ?? "",
          recipient,
          body.providerProductCode,
          compat,
        ),
        "bundle plan lookup",
      );
      if (!plan) return Response.json({ ok: false, error: "Bundle not found" }, { status: 404 });

      cost = Number(plan.price);
      title = `${network} ${plan.label} Data`;

      // Non-mock purchases require a durable customer retry key. Development
      // mock simulation retains its legacy DB-free harness behavior only.
      if (getDataProviderCode() !== "mock") {
        const key = req.headers.get("Idempotency-Key");
        if (!key) return Response.json({ ok: false, error: "Idempotency-Key required" }, { status: 400 });
        const lifecycle = new PurchaseLifecycle();
        const order = { reference: ref, walletId: wallet.id, network: network as "MTN" | "TELECEL", recipient,
          planLabel: plan.label, category: plan.category,
          providerProductCode: plan.providerProductCode, amount: cost };
        const claim = await lifecycle.create(order, key);
        if (claim.created) await lifecycle.submit(order);
        return Response.json({ ok: true, ref: claim.ref, cost,
          trackable: true, etaSeconds: null, provider: getDataProviderCode(),
          providerMessage: "Awaiting verified provider confirmation", ...(await lifecycle.summary(claim.ref)) });
      }

      if (balance < cost) {
        return Response.json({ ok: false, error: "insufficient_funds", needed: cost, balance }, { status: 402 });
      }

      // Belt-and-braces immediately before the irreversible debit. The route
      // preflight above already ran, but keeping this check adjacent to the
      // debit means a future refactor cannot reintroduce the old behaviour
      // (debit first, discover the provider is mock/unconfigured afterwards).
      assertDataProviderRuntimeSafe();

      // Atomic, conditional debit BEFORE the provider call: the `balance >= cost`
      // guard lives in the UPDATE itself, so concurrent purchases/transfers can
      // never overdraft the wallet and a concurrent deposit can never be
      // clobbered by a read-modify-write (which previously could let two
      // simultaneous purchases share one balance — spendable money out of thin
      // air). If the provider then fails, the same atomic arithmetic refunds the
      // pre-debit below, matching the "Not charged" ledger row.
      const debited = await db
        .update(wallets)
        .set({ balance: sql`${wallets.balance} - ${cost.toFixed(2)}::numeric` })
        .where(and(eq(wallets.id, wallet.id), sql`${wallets.balance} >= ${cost.toFixed(2)}::numeric`))
        .returning({ balance: wallets.balance });
      const chargedWallet = debited[0];
      if (!chargedWallet) {
        // Lost the race against a concurrent spend.
        return Response.json({ ok: false, error: "insufficient_funds", needed: cost, balance }, { status: 402 });
      }

      await ensureProviderFloatCapacity(network, cost);
      const gateway = await submitDataBundleOrder({
        reference: ref,
        walletId: wallet.id,
        network,
        recipient,
        planLabel: plan.label,
        category: plan.category,
        providerProductCode: plan.providerProductCode,
        amount: cost,
      });

      const status = gateway.status === "reversed" ? "failed" : gateway.status;
      const shouldCharge = status !== "failed";
      const chargedAt = shouldCharge ? new Date() : null;
      const fulfilledAt = status === "successful" ? new Date() : null;
      const pointsEarned = status === "successful" ? Math.max(1, Math.round(cost * POINTS_RATE)) : 0;
      const providerHint = clampText(gateway.providerMessage, 90);

      // Live wallet state after the (atomic) debit/refund — never re-derived
      // from the stale session snapshot.
      let liveBalance = Number(chargedWallet.balance);
      let livePoints = wallet.points;

      if (!shouldCharge) {
        // Provider failed: refund the pre-debit atomically. The ledger row
        // below says "Not charged" and carries no chargedAt, so the callback
        // path will never refund it a second time.
        const refunded = await db
          .update(wallets)
          .set({ balance: sql`${wallets.balance} + ${cost.toFixed(2)}::numeric` })
          .where(eq(wallets.id, wallet.id))
          .returning({ balance: wallets.balance });
        liveBalance = Number(refunded[0]?.balance ?? liveBalance);
      } else if (pointsEarned > 0) {
        const withPoints = await db
          .update(wallets)
          .set({ points: sql`${wallets.points} + ${pointsEarned}` })
          .where(eq(wallets.id, wallet.id))
          .returning({ points: wallets.points });
        livePoints = withPoints[0]?.points ?? livePoints;
      }

      const txSubtitle =
        status === "failed"
          ? `${subtitle} • Not charged`
          : providerHint
            ? clampText(`${subtitle} • ${providerHint}`)
            : subtitle;

      // (The wallet debit/refund and points award already happened atomically
      // above — before the provider call — so no further balance write here.)

      const txValues: typeof transactions.$inferInsert = {
        ref,
        walletId: wallet.id,
        type: "data",
        status,
        fulfillmentStatus: gateway.fulfillmentStatus,
        direction: "out",
        title,
        subtitle: txSubtitle,
        amount: cost.toFixed(2),
        points: pointsEarned,
        network,
        recipient,
        provider: gateway.providerCode,
        providerProductCode: plan.providerProductCode,
        providerReference: gateway.providerReference,
        providerStatus: gateway.providerStatus,
        providerMessage: clampText(gateway.providerMessage, 240) || null,
        fulfillmentAttempts: 1,
        chargedAt,
        fulfilledAt,
        lastProviderSyncAt: new Date(),
        providerPayload: gateway.rawRequest,
        providerResponse: gateway.rawResponse,
      };

      // `insertTransactionRow` skips the fulfillment/provider columns when the
      // database has not been migrated yet, so the order is still recorded.
      await insertTransactionRow(txValues);

      if (gateway.floatBalance != null) {
        const storedFloat = await getStoredProviderFloatBalance(network);
        await upsertProviderFloatBalance({
          providerCode: gateway.providerCode,
          network,
          availableBalance: gateway.floatBalance,
          reservedBalance:
            status === "pending" ? (storedFloat?.reservedBalance ?? 0) + cost : storedFloat?.reservedBalance ?? 0,
          lowBalanceThreshold: storedFloat?.lowBalanceThreshold ?? 0,
          lastReference: ref,
          lastStatus: gateway.providerStatus ?? gateway.status,
          notes: gateway.providerMessage,
          lastSyncedAt: new Date(),
        });
      } else {
        await projectProviderFloatUsage({
          providerCode: gateway.providerCode,
          network,
          amount: cost,
          status: gateway.status,
          reference: ref,
          message: gateway.providerMessage,
        });
      }

      if (status === "successful") {
        await creditReferralReward(auth.userId, wallet.id).catch((e) =>
          console.error("referral reward error", e),
        );
      }

      // How long the customer should expect to wait for the bundle. Once
      // delivered it's already done (0), otherwise it's the network estimate.
      const etaSeconds =
        status === "successful"
          ? 0
          : status === "pending"
            ? estimateDeliverySeconds({ type: "data", network, fulfillmentAttempts: 1 })
            : null;

      return Response.json({
        ok: true,
        status,
        ref,
        title,
        cost,
        pointsEarned,
        balance: liveBalance,
        points: livePoints,
        provider: gateway.providerCode,
        providerMessage: gateway.providerMessage,
        fulfillmentStatus: gateway.fulfillmentStatus,
        trackable: true,
        etaSeconds,
      });
    }

    if (kind === "airtime") {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
        return Response.json({ ok: false, error: "Enter an amount between GH₵ 1 and GH₵ 500" }, { status: 400 });
      }

      cost = Math.round(amount * (1 - AIRTIME_DISCOUNT) * 100) / 100;
      title = `${network} Airtime GH₵ ${amount.toFixed(0)}`;
      subtitle = `To ${groupPhone(recipient)} • ${(AIRTIME_DISCOUNT * 100).toFixed(0)}% off`;

      if (balance < cost) {
        return Response.json({ ok: false, error: "insufficient_funds", needed: cost, balance }, { status: 402 });
      }

      const status = rollLocalStatus();
      const pointsEarned = status === "successful" ? Math.max(1, Math.round(cost * POINTS_RATE)) : 0;

      // Same atomic, conditional debit as the data branch: no overdraft, no
      // clobbered concurrent deposit, and the response carries the values the
      // database actually has after the write.
      let newBalance = balance;
      let livePoints = wallet.points;
      if (status !== "failed") {
        const debited = await db
          .update(wallets)
          .set({
            balance: sql`${wallets.balance} - ${cost.toFixed(2)}::numeric`,
            ...(pointsEarned > 0 ? { points: sql`${wallets.points} + ${pointsEarned}` } : {}),
          })
          .where(and(eq(wallets.id, wallet.id), sql`${wallets.balance} >= ${cost.toFixed(2)}::numeric`))
          .returning({ balance: wallets.balance, points: wallets.points });
        const chargedWallet = debited[0];
        if (!chargedWallet) {
          // Lost the race against a concurrent spend — nothing was charged.
          return Response.json({ ok: false, error: "insufficient_funds", needed: cost, balance }, { status: 402 });
        }
        newBalance = Number(chargedWallet.balance);
        livePoints = chargedWallet.points;
      }

      const airtimeValues: typeof transactions.$inferInsert = {
        ref,
        walletId: wallet.id,
        type: "airtime",
        status,
        fulfillmentStatus:
          status === "successful" ? ("delivered" as const) : status === "pending" ? ("processing" as const) : ("failed" as const),
        direction: "out",
        title,
        subtitle: status === "failed" ? `${subtitle} • Not charged` : subtitle,
        amount: cost.toFixed(2),
        points: pointsEarned,
        network,
        recipient,
        chargedAt: status === "failed" ? null : new Date(),
        fulfilledAt: status === "successful" ? new Date() : null,
      };

      await insertTransactionRow(airtimeValues);

      if (status === "successful") {
        await creditReferralReward(auth.userId, wallet.id).catch((e) =>
          console.error("referral reward error", e),
        );
      }

      const airtimeEta =
        status === "successful"
          ? 0
          : status === "pending"
            ? estimateDeliverySeconds({ type: "airtime", network, fulfillmentAttempts: 1 })
            : null;

      return Response.json({
        ok: true,
        status,
        ref,
        title,
        cost,
        pointsEarned,
        balance: newBalance,
        points: livePoints,
        trackable: true,
        etaSeconds: airtimeEta,
      });
    }

    return Response.json({ ok: false, error: "Unknown purchase type" }, { status: 400 });
  } catch (error) {
    if (error instanceof PurchaseConflict) return Response.json({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof PurchaseFundsError) return Response.json({ ok: false, error: "insufficient_funds" }, { status: 402 });
    if (error instanceof TechlinkCatalogueError) {
      return Response.json({ ok: false, error: "Bundle is no longer available in the live catalogue", code: "catalogue_mismatch" }, { status: 409 });
    }
    if (error instanceof TechlinkConfigurationError) {
      return Response.json({ ok: false, error: "Techlink is not configured for this environment", code: "provider_unavailable" }, { status: 503 });
    }
    if (error instanceof TechlinkApiError) {
      return Response.json({ ok: false, error: "Techlink catalogue could not be verified", code: "provider_request_failed" }, { status: error.httpStatus === 401 ? 503 : 502 });
    }
    if (error instanceof DataProviderConfigError) {
      return Response.json({ ok: false, error: error.message, code: "provider_unavailable" }, { status: 503 });
    }
    if (error instanceof DataProviderFloatError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
          code: "provider_float_low",
          availableFloat: error.availableBalance,
        },
        { status: 503 },
      );
    }
    if (error instanceof DataProviderRequestError) {
      return Response.json({ ok: false, error: error.message, code: "provider_request_failed" }, { status: 502 });
    }

    console.error("purchase error", error);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
