/**
 * Order fulfillment tracking model.
 *
 * The purchase pipeline (`/api/purchase`, `/api/purchase/callback`) already
 * records where a data/airtime order is in its lifecycle
 * (`fulfillment_status`), when money was taken (`charged_at`), when the bundle
 * actually landed (`fulfilled_at`) and how many delivery attempts were made.
 * None of that ever reached the customer — history only showed a coarse
 * pending/successful dot with no sense of "how long until my data arrives".
 *
 * This module turns those raw ledger fields into something a person can read:
 * an ordered timeline of stages, a progress percentage, and — crucially — an
 * estimated delivery time so the buyer knows how long the wait should be.
 *
 * It is intentionally pure (no database, no `Date.now()` captured at import):
 * callers pass the transaction fields and, for anything time-relative, an
 * explicit `now`, so the same helper renders identically on the server (first
 * paint) and the client (live countdown) without hydration drift.
 */

export type FulfillmentStatus =
  | "queued"
  | "submitted"
  | "processing"
  | "delivered"
  | "failed"
  | "refunded";

export type TxStatus = "successful" | "pending" | "failed" | "reversed";

/** The stages a delivery moves through, in order. */
export type TrackStageId =
  | "placed"
  | "paid"
  | "submitted"
  | "processing"
  | "delivered";

export type TrackStageState = "done" | "current" | "upcoming" | "failed";

export type TrackStage = {
  id: TrackStageId;
  label: string;
  /** Short description shown under the label. */
  hint: string;
  state: TrackStageState;
  /** ISO timestamp this stage was reached, when known. */
  at: string | null;
};

/**
 * Everything the tracker UI needs, derived from a single transaction. Callers
 * can serialise this straight to the client — every field is JSON-safe.
 */
export type TrackingInfo = {
  ref: string;
  /** True for order types that actually get delivered to a phone. */
  trackable: boolean;
  status: TxStatus;
  fulfillmentStatus: FulfillmentStatus;
  /** High-level state the UI keys its colour/heading off. */
  phase: "processing" | "delivered" | "failed" | "refunded";
  /** 0-100. Reaches 100 only once the bundle is delivered (or terminal). */
  progress: number;
  stages: TrackStage[];
  /** ISO time we expect delivery to complete. Null once terminal. */
  estimatedDeliveryAt: string | null;
  /** Whole seconds until `estimatedDeliveryAt` from `now` (never negative). */
  etaSeconds: number | null;
  /** True when we are past the estimate but still not delivered. */
  overdue: boolean;
  /** Human sentence describing the wait, e.g. "Arriving in about 40s". */
  etaLabel: string;
  /** How long delivery actually took, in seconds, once delivered. */
  elapsedSeconds: number | null;
  attempts: number;
  provider: string | null;
  providerReference: string | null;
  providerMessage: string | null;
  network: string | null;
  recipient: string | null;
  title: string;
  amount: number;
  /** True while the client should keep polling for updates. */
  live: boolean;
  lastSyncedAt: string | null;
};

/**
 * Subset of a transaction the tracker reads. Mirrors the ledger columns added
 * by the data gateway; any that a legacy schema lacks are simply `null`.
 */
export type TrackableTx = {
  ref: string;
  type: string;
  status: string;
  fulfillmentStatus?: string | null;
  title: string;
  amount: number;
  network?: string | null;
  recipient?: string | null;
  provider?: string | null;
  providerReference?: string | null;
  providerMessage?: string | null;
  fulfillmentAttempts?: number | null;
  createdAt: string;
  chargedAt?: string | null;
  fulfilledAt?: string | null;
  refundedAt?: string | null;
  lastProviderSyncAt?: string | null;
};

/** Order types that are delivered to a phone and therefore worth tracking. */
const TRACKABLE_TYPES = new Set(["data", "airtime"]);

/**
 * Typical end-to-end delivery time (seconds) once payment clears. Data bundles
 * on the aggregator settle within a minute or two on a good day; airtime is
 * near-instant. These are estimates the UI counts down against, deliberately a
 * touch generous so we under-promise.
 */
const BASE_ESTIMATE_SECONDS: Record<string, number> = {
  data: 90,
  airtime: 30,
};

/**
 * Per-network multiplier on the base estimate. Telecel's bundle API tends to
 * take a little longer to acknowledge than MTN in practice.
 */
const NETWORK_FACTOR: Record<string, number> = {
  MTN: 1,
  TELECEL: 1.25,
};

/**
 * Extra seconds added per prior failed attempt — a retried order realistically
 * takes longer to land than a first-time one.
 */
const RETRY_PENALTY_SECONDS = 45;

const STAGE_ORDER: TrackStageId[] = ["placed", "paid", "submitted", "processing", "delivered"];

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function ms(value: string | null): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Where a fulfillment status sits on the 5-stage journey (0-based). */
function stageIndexFor(fulfillment: FulfillmentStatus, charged: boolean): number {
  switch (fulfillment) {
    case "delivered":
      return 4;
    case "processing":
      return 3;
    case "submitted":
      return 2;
    case "queued":
      return charged ? 1 : 0;
    case "failed":
    case "refunded":
      return charged ? 1 : 0;
  }
}

function normaliseFulfillment(tx: TrackableTx): FulfillmentStatus {
  const raw = (tx.fulfillmentStatus ?? "").toLowerCase();
  const allowed: FulfillmentStatus[] = [
    "queued",
    "submitted",
    "processing",
    "delivered",
    "failed",
    "refunded",
  ];
  if (allowed.includes(raw as FulfillmentStatus)) return raw as FulfillmentStatus;

  // Fall back to deriving it from the coarse tx status when the gateway column
  // is absent (legacy schema) or empty.
  switch (tx.status) {
    case "successful":
      return "delivered";
    case "failed":
      return "failed";
    case "reversed":
      return "refunded";
    default:
      return "processing";
  }
}

/** Estimated total delivery duration for this order, in seconds. */
export function estimateDeliverySeconds(tx: {
  type: string;
  network?: string | null;
  fulfillmentAttempts?: number | null;
}): number {
  const base = BASE_ESTIMATE_SECONDS[tx.type] ?? BASE_ESTIMATE_SECONDS.data;
  const factor = tx.network ? NETWORK_FACTOR[tx.network] ?? 1 : 1;
  const retries = Math.max(0, (tx.fulfillmentAttempts ?? 1) - 1);
  return Math.round(base * factor + retries * RETRY_PENALTY_SECONDS);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (mins < 60) return rem ? `${mins}m ${rem}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

const STAGE_META: Record<TrackStageId, { label: string; hint: string }> = {
  placed: { label: "Order placed", hint: "We received your request" },
  paid: { label: "Payment confirmed", hint: "Wallet debited securely" },
  submitted: { label: "Sent to network", hint: "Order handed to the carrier" },
  processing: { label: "Network processing", hint: "Carrier is loading the bundle" },
  delivered: { label: "Delivered", hint: "Bundle credited to the recipient" },
};

/**
 * Build the full tracking view for a transaction.
 *
 * @param tx  the transaction ledger fields
 * @param now current time in ms — pass `Date.now()`; injected so the server and
 *            client can agree, and so tests are deterministic.
 */
export function buildTrackingInfo(tx: TrackableTx, now: number = Date.now()): TrackingInfo {
  const trackable = TRACKABLE_TYPES.has(tx.type);
  const status = (["successful", "pending", "failed", "reversed"].includes(tx.status)
    ? tx.status
    : "pending") as TxStatus;
  const fulfillment = normaliseFulfillment(tx);

  const createdIso = toIso(tx.createdAt) ?? new Date(now).toISOString();
  const chargedIso = toIso(tx.chargedAt);
  const fulfilledIso = toIso(tx.fulfilledAt);
  const refundedIso = toIso(tx.refundedAt);
  const lastSyncedIso = toIso(tx.lastProviderSyncAt);

  const charged = Boolean(chargedIso) || status === "successful" || status === "pending";
  const failed = status === "failed";
  const refunded = status === "reversed" || fulfillment === "refunded";
  const delivered = status === "successful" || fulfillment === "delivered";

  const phase: TrackingInfo["phase"] = delivered
    ? "delivered"
    : refunded
      ? "refunded"
      : failed
        ? "failed"
        : "processing";

  const activeIndex = stageIndexFor(fulfillment, charged);

  // Timestamp we can attribute to each stage, best-effort from the ledger.
  const stageAt: Record<TrackStageId, string | null> = {
    placed: createdIso,
    paid: chargedIso ?? (charged ? createdIso : null),
    submitted: activeIndex >= 2 ? lastSyncedIso ?? chargedIso ?? createdIso : null,
    processing: activeIndex >= 3 ? lastSyncedIso ?? chargedIso ?? createdIso : null,
    delivered: fulfilledIso,
  };

  const terminal = delivered || failed || refunded;

  const stages: TrackStage[] = STAGE_ORDER.map((id, index) => {
    let state: TrackStageState;
    if (delivered) {
      state = "done";
    } else if ((failed || refunded) && index >= activeIndex) {
      // Everything the order actually reached is done; the stage it stalled on
      // is marked failed, later ones stay upcoming.
      state = index === activeIndex ? "failed" : "upcoming";
    } else if (index < activeIndex) {
      state = "done";
    } else if (index === activeIndex) {
      state = "current";
    } else {
      state = "upcoming";
    }
    return {
      id,
      label: STAGE_META[id].label,
      hint: STAGE_META[id].hint,
      state,
      at: stageAt[id],
    };
  });

  // Progress: reserve the last chunk for actual delivery so a "processing"
  // order never looks 100% done.
  let progress: number;
  if (delivered) progress = 100;
  else if (failed || refunded) progress = Math.min(90, (activeIndex / 4) * 100);
  else progress = Math.round((activeIndex / 4) * 92);

  // ETA maths.
  const estimateSeconds = estimateDeliverySeconds(tx);
  const anchorMs = ms(chargedIso) ?? ms(createdIso) ?? now;
  let estimatedDeliveryAt: string | null = null;
  let etaSeconds: number | null = null;
  let overdue = false;
  let elapsedSeconds: number | null = null;
  let etaLabel: string;

  if (delivered) {
    const start = anchorMs;
    const end = ms(fulfilledIso) ?? now;
    elapsedSeconds = Math.max(0, Math.round((end - start) / 1000));
    etaLabel = `Delivered in ${formatDuration(elapsedSeconds)}`;
  } else if (refunded) {
    etaLabel = "Refunded to your wallet";
  } else if (failed) {
    etaLabel = "Delivery failed — you were not charged";
  } else if (!trackable) {
    etaLabel = "";
  } else {
    const etaMs = anchorMs + estimateSeconds * 1000;
    estimatedDeliveryAt = new Date(etaMs).toISOString();
    const remaining = Math.round((etaMs - now) / 1000);
    if (remaining > 0) {
      etaSeconds = remaining;
      etaLabel = `Arriving in about ${formatDuration(remaining)}`;
    } else {
      etaSeconds = 0;
      overdue = true;
      etaLabel = "Finishing up — should land any moment";
    }
  }

  const live = trackable && !terminal;

  return {
    ref: tx.ref,
    trackable,
    status,
    fulfillmentStatus: fulfillment,
    phase,
    progress,
    stages,
    estimatedDeliveryAt,
    etaSeconds,
    overdue,
    etaLabel,
    elapsedSeconds,
    attempts: Math.max(1, tx.fulfillmentAttempts ?? 1),
    provider: tx.provider ?? null,
    providerReference: tx.providerReference ?? null,
    providerMessage: tx.providerMessage ?? null,
    network: tx.network ?? null,
    recipient: tx.recipient ?? null,
    title: tx.title,
    amount: tx.amount,
    live,
    lastSyncedAt: lastSyncedIso,
  };
}

/** Compact, client-safe ETA text for a countdown given seconds remaining. */
export function formatEtaCountdown(secondsRemaining: number | null, overdue: boolean): string {
  if (overdue) return "Any moment now";
  if (secondsRemaining == null) return "";
  if (secondsRemaining <= 0) return "Any moment now";
  return formatDuration(secondsRemaining);
}
