import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { adminAuditLogs, checkoutOrders } from "@/db/schema";
import { isSchemaIncompatibleError } from "@/lib/schema-compat";

/**
 * Phase 2, Step 2 — failed-order support actions (delivery resolved / refund review).
 *
 * `src/lib/checkout.ts` parks paid-but-undelivered Paystack orders as
 * `fulfillment_failed` with "Support will fulfil or refund this order" and
 * deliberately never auto-retries them. This module is the controlled
 * support loop for that queue. Like `customer-management.ts` (Step 1) it is
 * kept OUT of `src/lib/admin` so that directory's read-only guarantee remains
 * trivially verifiable.
 *
 * Exactly two actions exist:
 *
 *  - `delivery_resolved` — the admin CONFIRMS the customer actually received
 *    the data. It completes the transition the checkout flow already defines
 *    (`fulfilling → fulfilled`) by reusing the existing status columns:
 *    `order_status = 'fulfilled'`, `fulfillment_status = 'delivered'`,
 *    `fulfilled_at = now()`. No money column is written. No ledger row is
 *    created or touched. No provider call, point credit, referral reward or
 *    float bookkeeping is replayed — those belong to the checkout settlement
 *    flow and are deliberately not duplicated here.
 *  - `refund_review` — delivery failed and the customer should be refunded, so
 *    a finance review must happen. This is a RECORDING-ONLY action: the order
 *    row is byte-identical afterwards; the only write is one audit row. There
 *    is no refund workflow in this system that an admin could safely invoke
 *    (the one wallet refund lives inside the provider-authenticated
 *    `purchase/callback` path and moves balances — off-limits to wire into the
 *    admin UI), so per the acceptance rules no money ever moves from here.
 *
 * Money-safety, concretely: this module imports exactly two tables from
 * `@/db/schema` — `checkoutOrders` (status columns only) and
 * `adminAuditLogs`. It can never reach `wallets`, `transactions`,
 * `deposit_requests`, `provider_float_balances` or `agent_profiles`. Within
 * `checkout_orders` the only writable columns are the delivery-status fields;
 * `amount`, `amount_subunits`, `currency`, `payment_status` and every
 * `paystack_*` / provider column are never set here.
 *
 * Eligibility is enforced twice — in the pre-read (for a clear refusal) and in
 * the conditional UPDATE itself (race-safe). The WHERE clause mirrors the
 * Needs-Attention queue definition: payment captured, order unfulfilled, and
 * either explicitly parked (`fulfillment_failed`) or stuck past the same
 * `STUCK_AFTER_MS` window the queue uses. `STUCK_AFTER_MS` is duplicated here
 * as `SUPPORT_STUCK_AFTER_MS` — deliberately not imported from the admin read
 * layer so the write surface stays dependency-free — and the Phase 2 harness
 * asserts the two values stay equal.
 *
 * Replay safety: `delivery_resolved` UPDATEs only rows that are still in a
 * supportable state, so a replay changes nothing and writes no second audit
 * row. `refund_review` never changes the order, so duplicates are prevented
 * by the database itself: a partial UNIQUE index on `(target_ref, action)`
 * permits at most one recorded review per order — a replayed insert hits the
 * index and is reported as "already recorded" instead of duplicating the
 * trail.
 *
 * The acting admin is always supplied by the caller from the server-side
 * admin gate (`AdminContext.admin.userId`); nothing in this module accepts an
 * admin identity from a request body.
 */

export const SUPPORT_ACTIONS = ["delivery_resolved", "refund_review"] as const;
export type OrderSupportAction = (typeof SUPPORT_ACTIONS)[number];

/** Statuses an order may be in when a support action is attempted (pre-read). */
export const SUPPORTABLE_ORDER_STATUSES = ["fulfillment_failed", "paid", "fulfilling"] as const;

/** A checkout order is stuck once it has been paid but not fulfilled this long. */
export const SUPPORT_STUCK_AFTER_MS = 2 * 60 * 60 * 1000;

export const SUPPORT_MAX_REASON_LENGTH = 240;

export type SupportOrderInput = {
  /** The authenticated administrator (from the gate, never browser input). */
  adminUserId: number;
  /** `checkout_orders.ref` of the order the action targets. */
  orderRef: string;
  action: OrderSupportAction;
  /** Operator-supplied context, optional and clamped. */
  reason?: string | null;
};

export type SupportActionResult =
  | {
      ok: true;
      action: OrderSupportAction;
      /** False when the action was already recorded (idempotent replay). */
      changed: boolean;
      orderRef: string;
      orderId: number;
      targetUserId: number;
      /** Order status after the action. */
      orderStatus: string;
    }
  | {
      ok: false;
      error:
        | "order-not-found"
        | "order-not-actionable"
        | "order-already-resolved"
        | "schema-drift";
      /** Current order status when known, for the caller's message. */
      orderStatus?: string;
    };

/** The columns of `checkout_orders` a support action may look at. */
type SupportOrderRecord = {
  id: number;
  ref: string;
  userId: number;
  orderStatus: string;
  paymentStatus: string;
  updatedAt: Date;
};

/**
 * PURE eligibility rule — a support action may run only when money was
 * actually taken (payment captured), the order is not yet fulfilled, and it is
 * either explicitly parked as `fulfillment_failed` or stuck past the window.
 *
 * `now` is injected so the rule is deterministic and unit-testable.
 */
export function isSupportableOrder(
  order: Pick<SupportOrderRecord, "orderStatus" | "paymentStatus" | "updatedAt">,
  now: number = Date.now(),
): boolean {
  if (order.paymentStatus !== "successful") return false;
  if (order.orderStatus === "fulfillment_failed") return true;
  if (order.orderStatus === "paid" || order.orderStatus === "fulfilling") {
    const updated = order.updatedAt instanceof Date
      ? order.updatedAt.getTime()
      : new Date(order.updatedAt).getTime();
    return Number.isFinite(updated) && now - updated > SUPPORT_STUCK_AFTER_MS;
  }
  return false;
}

/**
 * Order references this feature will act on: the generated `CO-…` shape —
 * letters, digits, dash/underscore, 4–40 chars. Anything else (SQL fragments,
 * quotes, whitespace, oversized blobs) is rejected before reaching the
 * database, so the value can never bend a statement.
 */
export function normalizeOrderRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 4 || trimmed.length > 40) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

/** Action value parse — only the two supported actions ever exist. */
export function parseSupportAction(value: unknown): OrderSupportAction | null {
  return value === "delivery_resolved" || value === "refund_review" ? value : null;
}

/** Reason clamp — same contract as the Step 1 suspend/activate reason. */
export function clampSupportReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, SUPPORT_MAX_REASON_LENGTH);
}

/**
 * Detect the partial-unique-index violation that marks an already-recorded
 * action. Drizzle wraps driver errors in `DrizzleQueryError`, so walk the
 * `cause` chain (and match the standard constraint message as a fallback).
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    const entry = current as { code?: unknown; cause?: unknown; message?: unknown };
    if (entry.code === "23505") return true;
    if (
      typeof entry.message === "string" &&
      /duplicate key value violates unique constraint/i.test(entry.message)
    ) {
      return true;
    }
    current = entry.cause;
  }
  return false;
}

/**
 * Apply one support action to one checkout order. Every refusal is explicit;
 * there is no arbitrary status mutation on any path.
 */
export async function applyOrderSupportAction(
  input: SupportOrderInput,
): Promise<SupportActionResult> {
  const orderRef = normalizeOrderRef(input.orderRef);
  if (!orderRef) return { ok: false, error: "order-not-found" };
  const reason = clampSupportReason(input.reason);
  const now = new Date();

  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: checkoutOrders.id,
          ref: checkoutOrders.ref,
          userId: checkoutOrders.userId,
          orderStatus: checkoutOrders.orderStatus,
          paymentStatus: checkoutOrders.paymentStatus,
          updatedAt: checkoutOrders.updatedAt,
        })
        .from(checkoutOrders)
        .where(eq(checkoutOrders.ref, orderRef))
        .limit(1);

      const order = rows[0] as SupportOrderRecord | undefined;
      if (!order) return { ok: false, error: "order-not-found" } as const;

      // Already closed by support (or by a late provider settle) — report the
      // replay as a no-op rather than re-touching the row.
      if (order.orderStatus === "fulfilled") {
        return input.action === "delivery_resolved"
          ? ({ ok: false, error: "order-already-resolved", orderStatus: order.orderStatus } as const)
          : ({ ok: false, error: "order-not-actionable", orderStatus: order.orderStatus } as const);
      }

      if (!isSupportableOrder(order, now.getTime())) {
        return { ok: false, error: "order-not-actionable", orderStatus: order.orderStatus } as const;
      }

      if (input.action === "delivery_resolved") {
        // Conditional UPDATE is the safety net and the replay guard: it can
        // only fire on an order that is STILL paid-but-unfulfilled in a
        // supportable state. Only the three delivery-status columns are set —
        // never amount / payment_status / paystack_* / provider_* columns.
        const updated = await tx
          .update(checkoutOrders)
          .set({
            orderStatus: "fulfilled",
            fulfillmentStatus: "delivered",
            fulfilledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(checkoutOrders.ref, orderRef),
              eq(checkoutOrders.paymentStatus, "successful"),
              inArray(checkoutOrders.orderStatus, [...SUPPORTABLE_ORDER_STATUSES]),
            ),
          )
          .returning({ id: checkoutOrders.id });

        if (updated.length > 0) {
          await tx.insert(adminAuditLogs).values({
            adminUserId: input.adminUserId,
            targetUserId: order.userId,
            action: input.action,
            reason,
            targetRef: order.ref,
          });
        }

        return {
          ok: true as const,
          action: input.action,
          changed: updated.length > 0,
          orderRef: order.ref,
          orderId: order.id,
          targetUserId: order.userId,
          orderStatus: updated.length > 0 ? "fulfilled" : order.orderStatus,
        };
      }

      // refund_review — RECORDING ONLY. The order row is not touched: no
      // status change, no refund, no money. Idempotency (no duplicate audit
      // rows on replay) is enforced by the partial unique index on
      // (target_ref, action); a violation means the review is already
      // recorded, which is a successful no-op.
      try {
        await tx.insert(adminAuditLogs).values({
          adminUserId: input.adminUserId,
          targetUserId: order.userId,
          action: input.action,
          reason,
          targetRef: order.ref,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return {
            ok: true as const,
            action: input.action,
            changed: false,
            orderRef: order.ref,
            orderId: order.id,
            targetUserId: order.userId,
            orderStatus: order.orderStatus,
          };
        }
        throw error;
      }

      return {
        ok: true as const,
        action: input.action,
        changed: true,
        orderRef: order.ref,
        orderId: order.id,
        targetUserId: order.userId,
        orderStatus: order.orderStatus,
      };
    });
  } catch (error) {
    if (isSchemaIncompatibleError(error)) {
      console.error(
        "[flexidata:admin] order support action refused — the database is missing the " +
          "support workflow schema (admin_audit_logs.target_ref / widened action check). " +
          "Run `npx drizzle-kit push`.",
        error,
      );
      return { ok: false, error: "schema-drift" } as const;
    }
    throw error;
  }
}

/** HTTP message for each refusal the module can produce. */
export function supportActionRefusalMessage(result: {
  error: "order-not-found" | "order-not-actionable" | "order-already-resolved" | "schema-drift";
  orderStatus?: string;
}): { message: string; status: 404 | 409 | 500 } {
  switch (result.error) {
    case "order-not-found":
      return { message: "Order not found", status: 404 };
    case "order-already-resolved":
      return {
        message: "This order is already marked fulfilled — nothing to do",
        status: 409,
      };
    case "order-not-actionable":
      return {
        message:
          "This order is not in a support-actionable state (needs a captured payment and an unfulfilled, failed or stuck delivery)" +
          (result.orderStatus ? ` — current status: ${result.orderStatus}` : ""),
        status: 409,
      };
    case "schema-drift":
      return {
        message:
          "Support actions are unavailable because the database is missing the support workflow schema.",
        status: 500,
      };
  }
}
