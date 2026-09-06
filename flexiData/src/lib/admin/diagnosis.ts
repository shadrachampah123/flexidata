import type { AdminSeverity } from "@/lib/admin/types";
import type { TrackableTx } from "@/lib/fulfillment";

/**
 * Phase 2, Step 3 — the pure diagnosis engine behind the investigation pages.
 *
 * This module answers one question: **given the facts we already store about an
 * order or a deposit, what is actually wrong with it, and what is this
 * dashboard allowed to do about it?**
 *
 * It is deliberately, mechanically PURE:
 *
 *  - no `@/db` import, so it cannot run a query — let alone a write;
 *  - no `@/lib/paystack`, `@/lib/deposits`, `@/lib/checkout` or
 *    `@/lib/data-gateway` import, so it cannot settle, refund, retry or
 *    submit anything;
 *  - no `Date.now()` captured at import time — every time-relative rule takes
 *    an injected `now`, so the same input always produces the same findings
 *    and the whole rule set is unit-testable without a database;
 *  - facts in, findings out. Nothing is mutated, nothing is returned by
 *    reference to a database row.
 *
 * That makes it the single place where "what does this state mean" is written
 * down, which is exactly what a later, separately-approved money-moving step
 * would have to be built on top of. Every finding therefore carries a
 * `guidance` string that states what an operator can do **in this dashboard**
 * — and, just as importantly, what this dashboard cannot do (there is no
 * refund, no reversal, no balance correction and no delivery retry anywhere in
 * the admin area).
 *
 * The rules mirror the definitions already used elsewhere in the codebase
 * rather than inventing new ones:
 *
 *  - "support-actionable" is byte-for-byte the eligibility rule of
 *    `isSupportableOrder()` (`src/lib/support-actions.ts`) and of
 *    `isAttentionRowActionable()` (`src/lib/admin/queries-operations.ts`).
 *    The constant is duplicated here (as Step 2 duplicated it) so this module
 *    stays dependency-free, and the Step 3 harness asserts all three agree.
 *  - the verification-mismatch signature is the exact text
 *    `src/lib/checkout.ts` and `src/lib/deposits.ts` park a row with when
 *    Paystack reports `success` but the amount / currency / reference do not
 *    match. Those rows were NEVER credited or fulfilled.
 *  - the money-moved rule (`charged_at IS NOT NULL`, `refunded_at` marks a
 *    reversal) follows `src/lib/admin/reconciliation.ts`.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** An order is stuck once it has been paid but not fulfilled for this long. */
export const DIAGNOSIS_STUCK_AFTER_MS = 2 * 60 * 60 * 1000;

/** A funding attempt is stale once it has sat `pending` for this long. */
export const DIAGNOSIS_STALE_DEPOSIT_MS = 24 * 60 * 60 * 1000;

/** Money comparisons are exact to the pesewa; this absorbs float noise only. */
export const DIAGNOSIS_AMOUNT_TOLERANCE = 0.005;

/**
 * The message both settlement paths write when Paystack says `success` but the
 * charge does not match what we asked for. `checkout.ts`: "Payment did not
 * match the order (amount/currency/reference) and was not fulfilled…";
 * `deposits.ts`: "Payment did not match this deposit … and was not credited…".
 * One signature covers both, and matching on it is how an investigator
 * recognises a parked mismatch without re-deriving it from timestamps.
 */
export const MISMATCH_SIGNATURE = /did not match/i;

/** `deposits.ts` production lock: a demo/mock deposit parked in production. */
export const DEMO_LOCK_SIGNATURE = /demo deposits are disabled in production/i;

/** What the admin dashboard may never do — repeated in guidance on purpose. */
const NO_MONEY = "This dashboard cannot refund, reverse or adjust a balance.";

// ---------------------------------------------------------------------------
// Finding shape
// ---------------------------------------------------------------------------

export type DiagnosisFinding = {
  /** Stable machine id, used by tests and as a React key. */
  id: string;
  severity: AdminSeverity;
  /** One-line headline. */
  label: string;
  /** What the evidence says. */
  detail: string;
  /** What an operator can do about it — inside this dashboard or outside it. */
  guidance: string;
};

/** The banner at the top of an investigation page. */
export type DiagnosisVerdict = {
  severity: AdminSeverity;
  label: string;
  detail: string;
};

const SEVERITY_RANK: Record<AdminSeverity, number> = {
  critical: 0,
  attention: 1,
  unknown: 2,
  healthy: 3,
};

/**
 * Reduce a finding list to the single headline the banner shows: the most
 * severe finding wins, ties broken by the order the rules were written in
 * (which is an operational priority order, not alphabetical).
 */
export function summarizeFindings(findings: readonly DiagnosisFinding[]): DiagnosisVerdict {
  if (findings.length === 0) {
    return {
      severity: "healthy",
      label: "No discrepancy found",
      detail: "Everything this dashboard can check about this record agrees with itself.",
    };
  }
  const worst = findings.reduce((best, candidate) =>
    SEVERITY_RANK[candidate.severity] < SEVERITY_RANK[best.severity] ? candidate : best,
  );
  return { severity: worst.severity, label: worst.label, detail: worst.detail };
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function ageMs(value: string | null | undefined, now: number): number | null {
  const ms = toMs(value);
  return ms === null ? null : now - ms;
}

function hours(value: number | null): string {
  if (value === null) return "unknown";
  const hours = Math.floor(Math.abs(value) / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.round(Math.abs(value) / 60_000))} min`;
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

function subunitsOf(amount: number): number {
  return Math.round(amount * 100);
}

function amountsDiffer(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) > DIAGNOSIS_AMOUNT_TOLERANCE;
}

// ---------------------------------------------------------------------------
// Facts — the only inputs this module accepts
// ---------------------------------------------------------------------------

/** The `checkout_orders` columns the diagnosis reads (all already stored). */
export type OrderFacts = {
  ref: string;
  orderStatus: string;
  paymentStatus: string;
  fulfillmentStatus: string | null;
  amount: number;
  amountSubunits: number | null;
  currency: string | null;
  network: string | null;
  planLabel: string | null;
  recipient: string | null;
  paystackTransactionId: string | null;
  paystackGatewayResponse: string | null;
  providerReference: string | null;
  providerStatus: string | null;
  providerMessage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  paidAt: string | null;
  verifiedAt: string | null;
  fulfilledAt: string | null;
  failedAt: string | null;
  abandonedAt: string | null;
};

/** The ledger mirror row `checkout.ts` writes for visibility, if it exists. */
export type MirrorFacts = {
  exists: boolean;
  status: string | null;
  fulfillmentStatus: string | null;
  direction: string | null;
  amount: number | null;
  chargedAt: string | null;
  fulfilledAt: string | null;
  refundedAt: string | null;
};

/** One recorded admin action against this ref, oldest first or newest first. */
export type RecordedActionFacts = {
  action: string;
  at: string | null;
};

/** The `deposit_requests` columns the diagnosis reads. */
export type DepositFacts = {
  ref: string;
  status: string;
  provider: string | null;
  method: string | null;
  amount: number;
  amountSubunits: number | null;
  currency: string | null;
  paystackTransactionId: string | null;
  paystackGatewayResponse: string | null;
  initiatedAt: string | null;
  paidAt: string | null;
  verifiedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
};

/** Whether the wallet credit that a settled deposit implies actually exists. */
export type WalletCreditFacts = {
  /** Ledger rows with this ref and `direction = 'in'`. */
  creditRows: number;
  /** Of those, the ones with `status = 'successful'`. */
  successfulCredits: number;
  /** Ledger rows with this ref marked `reversed`. */
  reversedRows: number;
  /** Amount of the successful credit, when there is exactly one. */
  creditedAmount: number | null;
  creditedAt: string | null;
};

// ---------------------------------------------------------------------------
// Shared rule: is money actually at risk?
// ---------------------------------------------------------------------------

/**
 * PURE mirror of `isSupportableOrder()` (`src/lib/support-actions.ts`) and
 * `isAttentionRowActionable()` (`src/lib/admin/queries-operations.ts`): a
 * support action may be offered only when the payment was captured AND the
 * order is unfulfilled AND either explicitly parked or stuck past the window.
 * Three copies, one rule — the Step 3 harness proves they agree.
 */
export function isOrderSupportActionable(input: {
  paymentStatus: string;
  orderStatus: string;
  updatedAtMs: number | null;
  now?: number;
}): boolean {
  if (input.paymentStatus !== "successful") return false;
  if (input.orderStatus === "fulfillment_failed") return true;
  if (input.orderStatus === "paid" || input.orderStatus === "fulfilling") {
    return (
      input.updatedAtMs !== null &&
      (input.now ?? Date.now()) - input.updatedAtMs > DIAGNOSIS_STUCK_AFTER_MS
    );
  }
  return false;
}

/**
 * Is a refund review recorded against this ref still OPEN? A review is closed
 * only by a `delivery_resolved` recorded at or after it — exactly the rule the
 * refund-review backlog uses, so the page and the order view cannot disagree.
 */
export function hasOpenRefundReview(actions: readonly RecordedActionFacts[]): boolean {
  const reviews = actions
    .filter((entry) => entry.action === "refund_review")
    .map((entry) => toMs(entry.at))
    .filter((ms): ms is number => ms !== null);
  if (reviews.length === 0) return false;
  const resolutions = actions
    .filter((entry) => entry.action === "delivery_resolved")
    .map((entry) => toMs(entry.at))
    .filter((ms): ms is number => ms !== null);
  const lastResolution = resolutions.length === 0 ? null : Math.max(...resolutions);
  // A review recorded after the last resolution is still open.
  return reviews.some((reviewedAt) => lastResolution === null || reviewedAt > lastResolution);
}

/** Map an `AdminTransactionRow`-shaped mirror into the facts this module needs. */
export function mirrorFactsFrom(row: {
  status: string;
  fulfillmentStatus: string | null;
  direction: string;
  amount: number;
  chargedAt: string | null;
  fulfilledAt: string | null;
  refundedAt: string | null;
} | null): MirrorFacts {
  if (!row) {
    return {
      exists: false,
      status: null,
      fulfillmentStatus: null,
      direction: null,
      amount: null,
      chargedAt: null,
      fulfilledAt: null,
      refundedAt: null,
    };
  }
  return {
    exists: true,
    status: row.status,
    fulfillmentStatus: row.fulfillmentStatus,
    direction: row.direction,
    amount: row.amount,
    chargedAt: row.chargedAt,
    fulfilledAt: row.fulfilledAt,
    refundedAt: row.refundedAt,
  };
}

/**
 * Build the `TrackableTx` the existing customer-facing tracker consumes from a
 * CHECKOUT ORDER, so the delivery timeline renders even when the ledger mirror
 * row does not exist (which is precisely the parked case the investigation
 * page exists for). `buildTrackingInfo()` is reused verbatim — the provider
 * stays the source of truth and nothing here invents a stage.
 */
export function orderToTrackable(order: OrderFacts, mirror: MirrorFacts): TrackableTx {
  // The ledger row is the customer-facing record when it exists; prefer it so
  // the admin timeline and the customer timeline can never disagree.
  if (mirror.exists) {
    return {
      ref: order.ref,
      type: "data",
      status: mirror.status ?? "pending",
      fulfillmentStatus: mirror.fulfillmentStatus,
      title: `${order.network ?? ""} ${order.planLabel ?? ""} Data`.trim(),
      amount: mirror.amount ?? order.amount,
      network: order.network,
      recipient: order.recipient,
      provider: null,
      providerReference: order.providerReference,
      providerMessage: order.providerMessage,
      fulfillmentAttempts: null,
      createdAt: order.createdAt ?? new Date(0).toISOString(),
      chargedAt: mirror.chargedAt ?? order.paidAt,
      fulfilledAt: mirror.fulfilledAt ?? order.fulfilledAt,
      refundedAt: mirror.refundedAt,
      lastProviderSyncAt: order.updatedAt,
    };
  }

  // No mirror row: derive the same shape from the order columns. A captured
  // payment reads as `pending` until the provider reports, and a parked order
  // reads as `failed` — never as `successful`, because nothing was delivered.
  const captured = order.paymentStatus === "successful";
  const status = captured
    ? order.orderStatus === "fulfillment_failed"
      ? "failed"
      : order.orderStatus === "fulfilled"
        ? "successful"
        : "pending"
    : order.paymentStatus === "failed" || order.orderStatus === "payment_failed"
      ? "failed"
      : "pending";
  return {
    ref: order.ref,
    type: "data",
    status,
    fulfillmentStatus: order.fulfillmentStatus ?? (captured ? "queued" : null),
    title: `${order.network ?? ""} ${order.planLabel ?? ""} Data`.trim(),
    amount: order.amount,
    network: order.network,
    recipient: order.recipient,
    provider: null,
    providerReference: order.providerReference,
    providerMessage: order.providerMessage,
    fulfillmentAttempts: null,
    createdAt: order.createdAt ?? new Date(0).toISOString(),
    chargedAt: order.paidAt,
    fulfilledAt: order.fulfilledAt,
    refundedAt: null,
    lastProviderSyncAt: order.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Checkout-order diagnosis
// ---------------------------------------------------------------------------

/**
 * Classify one Paystack checkout order. Rules run in operational priority
 * order: money taken and nothing delivered comes first, integrity drift next,
 * and the "nothing is wrong" states last.
 */
export function diagnoseCheckoutOrder(input: {
  order: OrderFacts;
  mirror: MirrorFacts;
  actions?: readonly RecordedActionFacts[];
  now?: number;
}): DiagnosisFinding[] {
  const { order, mirror } = input;
  const actions = input.actions ?? [];
  const now = input.now ?? Date.now();
  const findings: DiagnosisFinding[] = [];
  const captured = order.paymentStatus === "successful";
  const gateway = order.paystackGatewayResponse ?? "";
  const updatedMs = toMs(order.updatedAt);

  // 1. Money taken, nothing delivered — the case the support queue exists for.
  if (captured && order.orderStatus === "fulfillment_failed") {
    findings.push({
      id: "captured-not-delivered",
      severity: "critical",
      label: "Payment captured, delivery failed",
      detail:
        `Paystack captured ${order.amount.toFixed(2)} ${order.currency ?? "GHS"} but the data provider did not ` +
        `complete the delivery${order.providerMessage ? ` ("${order.providerMessage}")` : ""}. ` +
        "The checkout flow parks these orders and never auto-retries them, because a retry could deliver the bundle twice.",
      guidance:
        "Work it from Requires support: mark delivered only after confirming the customer received the data, or record a refund review. " +
        NO_MONEY,
    });
  }

  // 2. Captured and still in flight past the stuck window.
  if (
    captured &&
    (order.orderStatus === "paid" || order.orderStatus === "fulfilling") &&
    updatedMs !== null &&
    now - updatedMs > DIAGNOSIS_STUCK_AFTER_MS
  ) {
    findings.push({
      id: "stuck-in-fulfilment",
      severity: "critical",
      label: "Paid but stuck in fulfilment",
      detail:
        `The payment was captured ${hours(ageMs(order.paidAt, now))} ago and the order has been "${order.orderStatus}" ` +
        `for ${hours(now - updatedMs)} — longer than the ${DIAGNOSIS_STUCK_AFTER_MS / 3_600_000}-hour window the support queue uses.`,
      guidance:
        "Confirm with the provider whether the bundle was actually submitted, then resolve it from Requires support. " + NO_MONEY,
    });
  }

  // 3. Paystack said success, our own guard said "that is not the charge we asked for".
  if (!captured && MISMATCH_SIGNATURE.test(gateway)) {
    findings.push({
      id: "verification-mismatch",
      severity: "critical",
      label: "Parked by the verification-mismatch guard",
      detail:
        `Paystack reported a successful charge that did not match this order's amount, currency or reference, so it was ` +
        `parked as "${order.orderStatus}" and never fulfilled. Recorded gateway note: "${gateway}".`,
      guidance:
        "Use the Paystack status probe to see what the gateway holds now, then settle the customer's position out-of-band. " +
        "Nothing was captured against this order in our records. " + NO_MONEY,
    });
  }

  // 4. Integrity: the display amount and the integer pesewas must agree.
  if (order.amountSubunits !== null && subunitsOf(order.amount) !== order.amountSubunits) {
    findings.push({
      id: "subunit-drift",
      severity: "critical",
      label: "Amount and subunit amount disagree",
      detail:
        `amount is ${order.amount.toFixed(2)} ${order.currency ?? "GHS"} (=${subunitsOf(order.amount)} pesewas) ` +
        `but amount_subunits is ${order.amountSubunits}. The subunit figure is what Paystack was asked to charge.`,
      guidance:
        "Treat the subunit value as the authoritative charge and reconcile the display amount with finance. " + NO_MONEY,
    });
  }

  // 5. A Paystack transaction id attached to a payment we do not record as captured.
  if (order.paystackTransactionId && !captured) {
    findings.push({
      id: "gateway-id-without-capture",
      severity: "attention",
      label: "Paystack transaction recorded but payment not captured",
      detail:
        `paystack_transaction_id ${order.paystackTransactionId} is stored while payment_status is "${order.paymentStatus}". ` +
        "The id is written on the way to a settle, on a mismatch park, and on a failure — so this is a prompt to check, not proof of a lost charge.",
      guidance: "Use the Paystack status probe to confirm whether money actually moved.",
    });
  }

  // 6. Ledger mirror divergence — the customer-facing history vs the order row.
  if (
    !mirror.exists &&
    ["paid", "fulfilling", "fulfilled", "fulfillment_failed"].includes(order.orderStatus)
  ) {
    findings.push({
      id: "mirror-missing",
      severity: "attention",
      label: "No ledger mirror row for this order",
      detail:
        "The checkout flow mirrors an order into `transactions` so history and tracking work, but no row with this reference exists. " +
        "That happens when the provider call itself threw before the mirror was written — the order stays parked and the customer sees nothing.",
      guidance:
        "This is why the order's delivery timeline here is derived from the order row instead of the ledger. " +
        "Resolve the order from Requires support; the ledger is never edited by this dashboard.",
    });
  }
  if (mirror.exists) {
    if (order.orderStatus === "fulfilled" && mirror.status !== "successful") {
      findings.push({
        id: "mirror-status-divergence",
        severity: "attention",
        label: "Ledger mirror disagrees with the order status",
        detail: `The order is "fulfilled" but the mirrored ledger row is "${mirror.status}".`,
        guidance:
          "The order row is authoritative for the checkout channel. Report the divergence; the ledger is never rewritten here.",
      });
    }
    if (amountsDiffer(mirror.amount, order.amount)) {
      findings.push({
        id: "mirror-amount-divergence",
        severity: "critical",
        label: "Ledger mirror amount differs from the order amount",
        detail: `Order amount ${order.amount.toFixed(2)} vs ledger mirror ${(mirror.amount ?? 0).toFixed(2)}.`,
        guidance: "Escalate to finance with both figures. " + NO_MONEY,
      });
    }
    if (mirror.refundedAt) {
      findings.push({
        id: "mirror-refund-divergence",
        severity: "attention",
        label: "Ledger mirror is marked refunded",
        detail:
          `The mirrored ledger row carries refunded_at (${mirror.refundedAt}) while the order row records no refund. ` +
          "Checkout-channel orders are not refunded through the ledger, so this row was written by another path.",
        guidance: "Investigate which flow wrote the refund before treating the customer as settled. " + NO_MONEY,
      });
    }
    if (mirror.direction !== "out") {
      findings.push({
        id: "mirror-direction",
        severity: "attention",
        label: "Ledger mirror is not a debit",
        detail: `A Paystack checkout mirror row should be direction "out" (the wallet is never touched); this one is "${mirror.direction}".`,
        guidance: "Report it; the ledger is never edited by this dashboard.",
      });
    }
  }

  // 7. Review state recorded by an administrator.
  if (hasOpenRefundReview(actions)) {
    const lastReview = actions
      .filter((entry) => entry.action === "refund_review")
      .map((entry) => toMs(entry.at))
      .filter((ms): ms is number => ms !== null)
      .sort((a, b) => b - a)[0];
    findings.push({
      id: "refund-review-open",
      severity: "attention",
      label: "Refund review recorded and still open",
      detail:
        `An administrator recorded a refund review ${hours(lastReview === undefined ? null : now - lastReview)} ago. ` +
        "A refund review is a RECORD that finance should look at it — no money moved and the order row was not changed.",
      guidance:
        "It stays open until the order is marked delivered or finance settles it out-of-band. See Refund reviews for the whole backlog. " +
        NO_MONEY,
    });
  }
  if (
    actions.some((entry) => entry.action === "delivery_resolved") &&
    order.orderStatus === "fulfilled"
  ) {
    findings.push({
      id: "admin-confirmed-delivery",
      severity: "healthy",
      label: "Delivery confirmed by an administrator",
      detail:
        "The fulfilled state on this order was recorded by an explicit admin confirmation through the support workflow, not by a provider callback. " +
        "The audit trail on this page shows who confirmed it, when and why.",
      guidance: "No action needed. The provider fields were left exactly as last reported.",
    });
  }

  // 8. Terminal states where no customer money is at risk.
  if (!captured && findings.length === 0) {
    findings.push({
      id: "nothing-captured",
      severity: "healthy",
      label: "No payment captured",
      detail: `payment_status is "${order.paymentStatus}" and order_status is "${order.orderStatus}": no customer money is held against this order.`,
      guidance: "Nothing to settle. The customer was never charged for this reference.",
    });
  }
  if (captured && order.orderStatus === "fulfilled" && findings.length === 0) {
    findings.push({
      id: "fulfilled-clean",
      severity: "healthy",
      label: "Paid and delivered",
      detail: "The payment was captured and the order reached its terminal fulfilled state with a matching ledger mirror.",
      guidance: "No action needed.",
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Deposit diagnosis
// ---------------------------------------------------------------------------

/** Classify one wallet funding attempt and whether its credit actually landed. */
export function diagnoseDeposit(input: {
  deposit: DepositFacts;
  credit: WalletCreditFacts;
  now?: number;
}): DiagnosisFinding[] {
  const { deposit, credit } = input;
  const now = input.now ?? Date.now();
  const findings: DiagnosisFinding[] = [];
  const gateway = deposit.paystackGatewayResponse ?? "";
  const settled = deposit.status === "successful";

  // 1. The wallet was never credited for a deposit we record as settled.
  if (settled && credit.successfulCredits === 0) {
    findings.push({
      id: "settled-not-credited",
      severity: "critical",
      label: "Deposit settled but no wallet credit in the ledger",
      detail:
        `deposit_requests says "successful" (${deposit.amount.toFixed(2)} ${deposit.currency ?? "GHS"}) but there is no ` +
        "successful inbound ledger row with this reference. Settlement and the credit are written in one transaction, so this should be impossible.",
      guidance:
        "Escalate immediately with the reference and the Paystack transaction id. " +
        "Reconciliation will also show the wallet's stored balance diverging from its ledger. " + NO_MONEY,
    });
  }

  // 2. More than one credit for one deposit.
  if (credit.successfulCredits > 1) {
    findings.push({
      id: "duplicate-credit",
      severity: "critical",
      label: "Wallet credited more than once for one deposit",
      detail: `${credit.successfulCredits} successful inbound ledger rows carry this reference.`,
      guidance:
        "Escalate immediately: this is a double-credit. Collect every ledger row before finance acts. " + NO_MONEY,
    });
  }

  // 3. The credit that landed is not the amount recorded.
  if (credit.successfulCredits === 1 && amountsDiffer(credit.creditedAmount, deposit.amount)) {
    findings.push({
      id: "credit-amount-divergence",
      severity: "critical",
      label: "Credited amount differs from the deposit amount",
      detail: `Deposit ${deposit.amount.toFixed(2)} vs credited ${(credit.creditedAmount ?? 0).toFixed(2)}.`,
      guidance: "Escalate to finance with both figures. " + NO_MONEY,
    });
  }

  // 4. Integrity: display amount vs the pesewas Paystack was asked to charge.
  if (deposit.amountSubunits !== null && subunitsOf(deposit.amount) !== deposit.amountSubunits) {
    findings.push({
      id: "subunit-drift",
      severity: "critical",
      label: "Amount and subunit amount disagree",
      detail:
        `amount is ${deposit.amount.toFixed(2)} (=${subunitsOf(deposit.amount)} pesewas) but amount_subunits is ` +
        `${deposit.amountSubunits}. The subunit figure is the exact amount Paystack verification must return before a wallet is credited.`,
      guidance: "Treat the subunit value as authoritative. " + NO_MONEY,
    });
  }

  // 5. Parked by the mismatch guard — the classic "customer says they paid".
  if (!settled && MISMATCH_SIGNATURE.test(gateway)) {
    findings.push({
      id: "verification-mismatch",
      severity: "critical",
      label: "Parked by the verification-mismatch guard",
      detail:
        `Paystack reported a successful charge that did not match this deposit's amount, currency or reference, so the wallet was ` +
        `NOT credited and the row was parked as "${deposit.status}". Recorded gateway note: "${gateway}".`,
      guidance:
        "Use the Paystack status probe to see what the gateway holds now. If the money is really there, the customer's own verify path " +
        "can still settle it — this dashboard never settles a deposit. " + NO_MONEY,
    });
  }

  // 6. Production lock: a demo/mock deposit refused in production.
  if (DEMO_LOCK_SIGNATURE.test(gateway)) {
    findings.push({
      id: "demo-deposit-locked",
      severity: "attention",
      label: "Demo deposit refused by the production lock",
      detail:
        "This deposit was not created through Paystack, and a production runtime refuses to credit a wallet from a non-Paystack deposit. " +
        "The row was parked as failed and no money moved.",
      guidance: "No customer money is involved. Clean-up of demo rows is a separate, scripted operation.",
    });
  }

  // 7. Left pending for more than a day.
  if (deposit.status === "pending") {
    const age = ageMs(deposit.initiatedAt, now);
    if (age !== null && age > DIAGNOSIS_STALE_DEPOSIT_MS) {
      findings.push({
        id: "stale-pending",
        severity: "attention",
        label: "Funding attempt pending for over 24 hours",
        detail: `Initiated ${hours(age)} ago and never confirmed by the provider.`,
        guidance:
          "Use the Paystack status probe: if the gateway has no successful charge, the customer abandoned the checkout and nothing is owed.",
      });
    }
  }

  // 8. A reversal recorded in the ledger.
  if (credit.reversedRows > 0) {
    findings.push({
      id: "credit-reversed",
      severity: "attention",
      label: "A ledger row for this reference is reversed",
      detail: `${credit.reversedRows} row(s) with this reference carry status "reversed".`,
      guidance: "Check whether the customer was told the top-up failed after a credit landed. " + NO_MONEY,
    });
  }

  // 9. A Paystack id stored against a deposit we do not record as settled.
  if (deposit.paystackTransactionId && !settled) {
    findings.push({
      id: "gateway-id-without-settle",
      severity: "attention",
      label: "Paystack transaction recorded but deposit not settled",
      detail: `paystack_transaction_id ${deposit.paystackTransactionId} is stored while status is "${deposit.status}".`,
      guidance: "Use the Paystack status probe to confirm whether the charge actually succeeded.",
    });
  }

  // 10. Clean states.
  if (settled && credit.successfulCredits === 1 && findings.length === 0) {
    findings.push({
      id: "credited-clean",
      severity: "healthy",
      label: "Settled and credited",
      detail:
        `The deposit was verified with Paystack and exactly one successful credit of ${deposit.amount.toFixed(2)} ` +
        `${deposit.currency ?? "GHS"} landed in the ledger${credit.creditedAt ? ` at ${credit.creditedAt}` : ""}.`,
      guidance: "No action needed.",
    });
  }
  if (!settled && findings.length === 0) {
    findings.push({
      id: "not-settled",
      severity: "healthy",
      label: "Not settled — wallet never credited",
      detail: `status is "${deposit.status}" and there is no credit in the ledger, so the two agree: no money moved into this wallet.`,
      guidance: "Nothing to settle. If the customer believes they paid, use the Paystack status probe.",
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Paystack probe diagnosis (S3.6)
// ---------------------------------------------------------------------------

/** What `paystackVerifyTransaction()` returns, normalised to JSON-safe values. */
export type PaystackProbeView = {
  status: string;
  rawStatus: string;
  reference: string | null;
  amountSubunits: number | null;
  currency: string | null;
  transactionId: string | null;
  channel: string | null;
  paidAt: string | null;
  gatewayResponse: string | null;
};

/** The stored values a probe result is compared against. */
export type ProbeSubject = {
  kind: "order" | "deposit";
  ref: string;
  /** `checkout_orders.payment_status` or `deposit_requests.status`. */
  storedStatus: string;
  storedAmountSubunits: number | null;
  storedCurrency: string | null;
  storedTransactionId: string | null;
  /** For a deposit: whether the wallet credit exists. For an order: unused. */
  credited?: boolean;
};

/**
 * Compare Paystack's live answer with what we stored — using the SAME three
 * predicates the settlement paths use (reference, integer pesewas, currency),
 * so a probe can never claim a charge matches when `checkout.ts` /
 * `deposits.ts` would have refused it.
 *
 * This is a comparison only. Nothing here settles, credits, refunds or writes.
 */
export function diagnosePaystackProbe(input: {
  subject: ProbeSubject;
  probe: PaystackProbeView;
}): DiagnosisFinding[] {
  const { subject, probe } = input;
  const findings: DiagnosisFinding[] = [];
  const record = subject.kind === "order" ? "order" : "deposit";
  const captured =
    subject.kind === "order"
      ? subject.storedStatus === "successful"
      : subject.storedStatus === "successful";

  // The exact predicates from the settlement paths. `deposits.ts` tolerates a
  // missing reference in the response (it falls back to our own ref);
  // `checkout.ts` requires an exact match. Both are mirrored here.
  const referenceOk =
    subject.kind === "order"
      ? probe.reference === subject.ref
      : (probe.reference ?? subject.ref) === subject.ref;
  const amountOk =
    probe.amountSubunits !== null &&
    subject.storedAmountSubunits !== null &&
    probe.amountSubunits === subject.storedAmountSubunits;
  const currencyOk =
    (probe.currency ?? "").toUpperCase() === (subject.storedCurrency ?? "GHS").toUpperCase();

  if (probe.status === "success") {
    if (!referenceOk || !amountOk || !currencyOk) {
      findings.push({
        id: "probe-mismatch",
        severity: "critical",
        label: "Paystack holds a successful charge that does not match this record",
        detail:
          `Paystack: reference ${probe.reference ?? "—"}, ${
            probe.amountSubunits === null ? "amount unknown" : `${probe.amountSubunits} pesewas`
          }, currency ${probe.currency ?? "—"}. ` +
          `Stored: reference ${subject.ref}, ${
            subject.storedAmountSubunits === null ? "amount unknown" : `${subject.storedAmountSubunits} pesewas`
          }, currency ${subject.storedCurrency ?? "GHS"}. ` +
          `referenceOk=${referenceOk}, amountOk=${amountOk}, currencyOk=${currencyOk}.`,
        guidance:
          `This is exactly the combination the settlement path refuses to credit or fulfil, so the ${record} was parked. ` +
          "Finance must settle the customer's position out-of-band. " + NO_MONEY,
      });
    } else if (!captured) {
      findings.push({
        id: "probe-captured-not-settled",
        severity: "critical",
        label: "Paystack records a matching successful charge we have not settled",
        detail:
          `Paystack says "${probe.rawStatus}" for ${probe.amountSubunits} pesewas (transaction ${probe.transactionId ?? "—"}), ` +
          `while our ${record} status is "${subject.storedStatus}".`,
        guidance:
          subject.kind === "deposit"
            ? "The customer's own verify path is the only code allowed to settle this deposit; this dashboard never does. " +
              "Ask the customer to retry the top-up verification, or settle out-of-band. " + NO_MONEY
            : "The customer's checkout verify path is the only code allowed to settle and fulfil this order; this dashboard never does. " +
              "Resolve the customer's position from Requires support or out-of-band. " + NO_MONEY,
      });
    } else if (subject.kind === "deposit" && subject.credited === false) {
      findings.push({
        id: "probe-settled-not-credited",
        severity: "critical",
        label: "Deposit settled and confirmed by Paystack, but no wallet credit",
        detail:
          `Paystack confirms the charge and deposit_requests says "successful", yet no successful inbound ledger row exists for ${subject.ref}.`,
        guidance: "Escalate immediately with this probe result and the reference. " + NO_MONEY,
      });
    } else {
      findings.push({
        id: "probe-agrees",
        severity: "healthy",
        label: "Paystack agrees with our records",
        detail: `Both sides record a successful charge of ${probe.amountSubunits} pesewas in ${probe.currency ?? "—"}.`,
        guidance: "No discrepancy to resolve.",
      });
    }
    return findings;
  }

  if (probe.status === "failed" || probe.status === "reversed" || probe.status === "abandoned") {
    if (captured) {
      findings.push({
        id: "probe-contradicts-capture",
        severity: "critical",
        label: "Paystack contradicts a payment we recorded as captured",
        detail:
          `Our ${record} records payment_status/status "successful" but Paystack now reports "${probe.rawStatus}" ` +
          `(${probe.gatewayResponse ?? "no gateway message"}).`,
        guidance:
          "Escalate to finance before acting on this record: either a reversal happened at the gateway or the stored state is wrong. " +
          NO_MONEY,
      });
    } else {
      findings.push({
        id: "probe-not-captured",
        severity: "healthy",
        label: "Paystack confirms no money was taken",
        detail: `Paystack reports "${probe.rawStatus}" and our ${record} is "${subject.storedStatus}" — the two agree.`,
        guidance: "Nothing is owed to or by the customer for this reference.",
      });
    }
    return findings;
  }

  // Anything else is Paystack's "not paid yet" bucket (ongoing / pending / …).
  findings.push({
    id: "probe-pending",
    severity: captured ? "attention" : "unknown",
    label: captured
      ? "Paystack still reports the charge as in progress"
      : "Paystack has no completed charge for this reference",
    detail: `Paystack reports "${probe.rawStatus}" while our ${record} status is "${subject.storedStatus}".`,
    guidance: captured
      ? "Re-probe shortly. If it stays in progress, treat the gateway as the source of truth and escalate. " + NO_MONEY
      : "Nothing was captured. If the customer believes otherwise, ask them for the Paystack receipt reference.",
  });
  return findings;
}
