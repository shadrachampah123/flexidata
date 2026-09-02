import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { bundlePlans, transactions, wallets } from "@/db/schema";
import { insertTransactionRow } from "@/lib/data";
import { requireAccount } from "@/lib/api-auth";
import { creditReferralReward } from "@/lib/referrals";
import {
  DataProviderConfigError,
  DataProviderFloatError,
  DataProviderRequestError,
  deriveProviderProductCode,
  ensureProviderFloatCapacity,
  getStoredProviderFloatBalance,
  projectProviderFloatUsage,
  submitDataBundleOrder,
  upsertProviderFloatBalance,
} from "@/lib/data-gateway";
import { estimateDeliverySeconds } from "@/lib/fulfillment";
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
 * Plan lookup that tolerates a database without `provider_product_code`: the
 * aggregator SKU is then derived from the plan identity instead of failing the
 * whole purchase.
 */
async function findBundlePlan(
  network: string,
  category: string,
  label: string,
  compat: SchemaCapabilities,
): Promise<FoundPlan | null> {
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
    return {
      ...row,
      providerProductCode:
        row.providerProductCode?.trim() || deriveProviderProductCode(network, category, label),
    };
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
    // Authenticate first — unauthenticated callers must never reach the
    // money-moving logic or receive anything but a clean 401.
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;

    const body = (await req.json()) as Body;
    const { kind, network, recipient } = body;

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
        (compat) => findBundlePlan(network, body.category ?? "", body.planLabel ?? "", compat),
        "bundle plan lookup",
      );
      if (!plan) return Response.json({ ok: false, error: "Bundle not found" }, { status: 404 });

      cost = Number(plan.price);
      title = `${network} ${plan.label} Data`;

      if (balance < cost) {
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
      const newBalance = shouldCharge ? balance - cost : balance;
      const providerHint = clampText(gateway.providerMessage, 90);
      const txSubtitle =
        status === "failed"
          ? `${subtitle} • Not charged`
          : providerHint
            ? clampText(`${subtitle} • ${providerHint}`)
            : subtitle;

      if (shouldCharge) {
        await db
          .update(wallets)
          .set({
            balance: newBalance.toFixed(2),
            points: wallet.points + pointsEarned,
          })
          .where(eq(wallets.id, wallet.id));
      }

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
        balance: newBalance,
        points: wallet.points + pointsEarned,
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
      const newBalance = status === "failed" ? balance : balance - cost;
      const pointsEarned = status === "successful" ? Math.max(1, Math.round(cost * POINTS_RATE)) : 0;

      if (status !== "failed") {
        await db
          .update(wallets)
          .set({
            balance: newBalance.toFixed(2),
            points: wallet.points + pointsEarned,
          })
          .where(eq(wallets.id, wallet.id));
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
        points: wallet.points + pointsEarned,
        trackable: true,
        etaSeconds: airtimeEta,
      });
    }

    return Response.json({ ok: false, error: "Unknown purchase type" }, { status: 400 });
  } catch (error) {
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
