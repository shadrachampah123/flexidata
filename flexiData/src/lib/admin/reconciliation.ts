import { sql, type SQL } from "drizzle-orm";

/**
 * Wallet reconciliation — the maths behind "Stored wallet balance" vs
 * "Calculated/expected balance".
 *
 * ## What this is
 *
 * `wallets.balance` is the ONLY authoritative figure in FlexiData. It is moved
 * exclusively by atomic SQL arithmetic (`balance = balance ± x`) inside the same
 * transaction that writes the matching ledger row. `transactions` is a parallel
 * record, not a second ledger: it has no `balance_after` column, no running
 * total and no foreign key to `wallets`.
 *
 * That is exactly why comparing the two is a meaningful check — and why the
 * result of that comparison is **never** a correction. This module produces a
 * *diagnosis*, classified and explained, for a human to investigate.
 *
 * ## What is deliberately NOT here
 *
 * - No "fix", "adjust" or "set balance" path. Phase 1 does not write.
 * - No assumption about WHICH transaction caused a difference. The pure
 *   classifier below never names a culprit; the UI shows the transactions that
 *   contributed to the sum and labels the finding "Requires investigation".
 *
 * The SQL fragments are the single source of truth for which ledger rows moved
 * money. They are used by the wallet list, the reconciliation screen and the
 * overview's discrepancy count, so those three can never disagree.
 */

/**
 * Ledger types that move real wallet cash without ever setting `charged_at`.
 *
 * `charged_at` is written by the data-gateway paths (purchases, checkout orders
 * and Paystack deposits). Transfers, points redemptions and airtime conversions
 * move the balance directly and predate that column, so requiring
 * `charged_at IS NOT NULL` alone would report a false discrepancy for every
 * wallet that has ever made a transfer.
 */
export const CASH_TYPES_WITHOUT_CHARGED_AT = ["transfer", "redemption", "conversion"] as const;

/** Two pesewas: below this a difference is float noise, not a finding. */
export const RECONCILIATION_TOLERANCE = 0.005;

export type ReconciliationCapabilities = {
  /** `transactions.charged_at` exists (gateway column). */
  chargedAt: boolean;
  /** `transactions.refunded_at` exists (gateway column). */
  refundedAt: boolean;
  /** `checkout_orders` exists — needed to exclude Paystack-funded orders. */
  checkoutTable: boolean;
};

export type ReconciliationRule = {
  id: "ledger-flags" | "ledger-status-only";
  /** Short label rendered next to the calculated figure. */
  label: string;
  /** False when the database lacks a column the rule wants: the figure is an estimate. */
  exact: boolean;
  /** Why the figure is (or is not) trustworthy, shown in the UI. */
  note: string;
};

export function reconciliationRule(caps: ReconciliationCapabilities): ReconciliationRule {
  if (caps.chargedAt && caps.refundedAt && caps.checkoutTable) {
    return {
      id: "ledger-flags",
      label: "Ledger-derived (charged flag)",
      exact: true,
      note:
        "Sums every ledger row that actually moved wallet cash: successful rows, and pending or " +
        "failed rows that were charged, provided no refund is recorded against them. Paystack " +
        "checkout orders are excluded because they never touch the wallet.",
    };
  }
  return {
    id: "ledger-status-only",
    label: "Ledger-derived (status only — estimate)",
    exact: false,
    note:
      "This database is missing ledger columns the calculation needs, so the figure is an ESTIMATE: " +
      "rows that were charged and later refunded in place cannot be told apart from rows that never " +
      "moved money. Treat every difference as unconfirmed until the schema is up to date.",
  };
}

function col(alias: string, column: string): SQL {
  return sql.raw(`"${alias}"."${column}"`);
}

/**
 * The one predicate that decides whether a `transactions` row moved wallet cash.
 *
 * @param alias alias of the `transactions` table in the surrounding statement
 *              (a server-side constant, never user input).
 */
export function moneyMovedSql(alias: string, caps: ReconciliationCapabilities): SQL {
  const t = (column: string) => col(alias, column);

  // Payment taken, payment taken and still settling (pending), or payment taken
  // and the order then failed without a recorded refund. That last case is
  // exactly the "wallet charged, bundle never sent, no refund" situation the
  // support queue also flags, so the two screens cannot disagree.
  const settled = caps.chargedAt
    ? sql`(${t("status")} = 'successful' or (${t("status")} in ('pending', 'failed') and ${t("charged_at")} is not null))`
    : sql`(${t("status")} = 'successful')`;

  // A reversed/refunded row records money that came back: net effect zero.
  const notRefunded = caps.refundedAt ? sql`${t("refunded_at")} is null` : null;

  // Pay-as-you-go checkout orders are mirrored into the ledger for history and
  // tracking, but the money came from Paystack — the wallet was never debited.
  // Without this clause every checkout order would look like a missing debit.
  const notCheckoutFunded = caps.checkoutTable
    ? sql`not exists (select 1 from "checkout_orders" "co" where "co"."ref" = ${t("ref")})`
    : null;

  // Cash types that never set charged_at.
  const charged = caps.chargedAt
    ? sql`(${t("charged_at")} is not null or ${t("type")} in (${sql.raw(
        CASH_TYPES_WITHOUT_CHARGED_AT.map((type) => `'${type}'`).join(", "),
      )}))`
    : null;

  const parts = [settled, notRefunded, notCheckoutFunded, charged].filter(
    (part): part is SQL => part !== null,
  );

  return sql`(${sql.join(parts, sql` and `)})`;
}

/** Signed cash effect of one ledger row, as a SQL expression. */
export function signedAmountSql(alias: string): SQL {
  return sql`(case when ${col(alias, "direction")} = 'in' then ${col(alias, "amount")} else -${col(alias, "amount")} end)`;
}

/**
 * `coalesce(sum(…), 0)` — the expected balance for one wallet from its ledger.
 * Rows that did not move money contribute 0, which is why they are still in the
 * denominator of "transactions examined".
 */
export function calculatedBalanceSql(alias: string, caps: ReconciliationCapabilities): SQL {
  const moved = moneyMovedSql(alias, caps);
  return sql`coalesce(sum(case when ${moved} then ${signedAmountSql(alias)} else 0 end), 0)`;
}

/** How many ledger rows contributed to the calculated balance. */
export function movedCountSql(alias: string, caps: ReconciliationCapabilities): SQL {
  return sql`coalesce(count(*) filter (where ${moneyMovedSql(alias, caps)}), 0)`;
}

/** When the most recent money-moving row was created. */
export function lastMovedAtSql(alias: string, caps: ReconciliationCapabilities): SQL {
  return sql`max(${col(alias, "created_at")}) filter (where ${moneyMovedSql(alias, caps)})`;
}

// ---------------------------------------------------------------------------
// Pure classification — no database, no clock, unit-testable.
// ---------------------------------------------------------------------------

export type ReconciliationStatus = "matched" | "mismatch" | "unknown";

export type ReconciliationVerdict = {
  /** Stored minus calculated, rounded to two decimals. Null when unknowable. */
  difference: number | null;
  status: ReconciliationStatus;
  /** Traffic light used by the UI: 🟢 / 🔴 / ⚪. */
  severity: "healthy" | "critical" | "unknown";
  /** Short badge label. */
  label: string;
  /** One-line operator instruction. */
  guidance: string;
  /** True when the calculated figure is only an estimate (schema drift). */
  estimated: boolean;
};

/**
 * Classify stored-vs-calculated for one wallet.
 *
 * The classifier never guesses a cause. Even an exact match of, say, one
 * purchase amount is not "proof" that a purchase is the culprit: the same
 * difference can come from a manual database correction, the blocked
 * airtime-conversion route's read-modify-write, or a row that predates the
 * gateway columns. Those possibilities are surfaced as text, not conclusions.
 */
export function classifyReconciliation(input: {
  storedBalance: number | null;
  calculatedBalance: number | null;
  examined: number | null;
  rule: ReconciliationRule;
}): ReconciliationVerdict {
  const { storedBalance, calculatedBalance, examined, rule } = input;
  const estimated = !rule.exact;

  if (storedBalance === null || calculatedBalance === null) {
    return {
      difference: null,
      status: "unknown",
      severity: "unknown",
      label: "Not available",
      guidance:
        "This database does not expose enough ledger detail to calculate an expected balance. " +
        "Run `npx drizzle-kit push` to enable the gateway columns.",
      estimated,
    };
  }

  const difference = Math.round((storedBalance - calculatedBalance) * 100) / 100;

  if (Math.abs(difference) <= RECONCILIATION_TOLERANCE) {
    return {
      difference: 0,
      status: "matched",
      severity: "healthy",
      label: "Matched",
      guidance:
        examined === 0
          ? "No money-moving ledger rows — the stored balance and the ledger agree at zero."
          : "Stored wallet balance matches the value calculated from the ledger.",
      estimated,
    };
  }

  return {
    difference,
    status: "mismatch",
    severity: "critical",
    label: estimated ? "Possible mismatch" : "Mismatch",
    guidance: "Requires investigation",
    estimated,
  };
}

/**
 * Benign explanations an investigator should rule out before treating a
 * difference as a defect. Shown verbatim on the reconciliation screen so the
 * dashboard never implies a single cause.
 */
export const RECONCILIATION_CAUSES: readonly string[] = [
  "A wallet balance corrected directly in the database (no ledger row is written by such a change).",
  "Ledger rows written before the data-gateway columns existed — they carry an amount but no charged/refunded flag.",
  "The airtime-conversion route (blocked in production) updates the balance by read-modify-write and can lose a concurrent movement.",
  "A Paystack-funded checkout order mirrored into the ledger: money that never touched the wallet.",
  "A refund applied by the provider callback, which reverses a row in place rather than adding a contra entry.",
  "Points and cash share one row: loyalty movements are not cash and are excluded from this calculation.",
];
