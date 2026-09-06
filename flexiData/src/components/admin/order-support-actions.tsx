"use client";

import { useState } from "react";
import { CircleCheck, Loader2, ReceiptText } from "lucide-react";

/**
 * Failed-order support actions for the Requires support queue (Phase 2, Step 2).
 *
 * This is the SECOND deliberate write surface in the admin browser UI, exactly
 * alongside the Step 1 suspend/activate control, and it follows the same
 * contract: nothing changes on its own. A modal forces the operator to read
 * the order summary, type the EXACT order reference as the confirmation, and
 * choose the action explicitly. Only then is a POST sent — to the single
 * gated endpoint — with `confirm: true` and the typed reference. The API
 * independently re-runs the admin gate, re-checks eligibility against the live
 * row and refuses to act without the confirmation.
 *
 * The two actions it can record:
 *  - "Mark delivered — confirmed" (delivery_resolved): the admin has VERIFIED
 *    outside this screen that the customer actually received the data.
 *  - "Queue refund review" (refund_review): delivery failed and finance should
 *    refund. This records the review ONLY — it never moves money, touches a
 *    wallet, reverses a deposit, or retries anything. There is no refund
 *    execution here at all.
 *
 * No password, hash, key or secret is displayed or accepted by this
 * component — it renders only the fields the queue row already carries.
 */

export type OrderSupportActionKind = "delivery_resolved" | "refund_review";

type SupportOrderSummary = {
  ref: string;
  customerName: string | null;
  phone: string;
  bundle: string;
  amount: number;
  status: string;
  reason: string;
  createdAt: string;
};

const ACTION_LABEL: Record<OrderSupportActionKind, string> = {
  delivery_resolved: "Mark delivered — confirmed",
  refund_review: "Queue refund review",
};

export function OrderSupportActions({
  order,
  canResolve,
  canReview,
  onDone,
}: {
  order: SupportOrderSummary;
  /** The server decided this order may be marked delivered (and re-checks it). */
  canResolve: boolean;
  /** The server decided this order may be queued for refund review. */
  canReview: boolean;
  /** Called after a successful action so the list can re-fetch. */
  onDone?: () => void;
}) {
  const [pending, setPending] = useState<OrderSupportActionKind | null>(null);
  const [typedRef, setTypedRef] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!canResolve && !canReview) return null;

  const openModal = (action: OrderSupportActionKind) => {
    setPending(action);
    setTypedRef("");
    setReason("");
    setError(null);
    setNotice(null);
  };

  const closeModal = () => {
    if (busy) return;
    setPending(null);
    setError(null);
    setNotice(null);
  };

  const matchesRef = pending !== null && typedRef.trim() === order.ref;

  const confirmAction = async () => {
    if (!pending || !matchesRef) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(order.ref)}/support`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: pending,
          orderRef: order.ref,
          confirm: true,
          reason: reason.trim() || null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        changed?: boolean;
        error?: string;
      } | null;

      if (response.status === 404) {
        setError("This action is no longer available — your admin session may have ended.");
        return;
      }
      if (!response.ok || !payload?.ok) {
        setError(payload?.error ?? "The action could not be recorded. Reload the page and try again.");
        return;
      }
      closeModal();
      if (payload.changed === false) {
        setNotice("Already recorded — nothing changed.");
      }
      onDone?.();
    } catch {
      setError("The request failed. Reload the page and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {canResolve && (
          <button
            type="button"
            onClick={() => openModal("delivery_resolved")}
            className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400"
          >
            <CircleCheck className="h-3 w-3" />
            Mark delivered
          </button>
        )}
        {canReview && (
          <button
            type="button"
            onClick={() => openModal("refund_review")}
            className="inline-flex items-center gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-400"
          >
            <ReceiptText className="h-3 w-3" />
            Refund review
          </button>
        )}
      </div>

      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={ACTION_LABEL[pending]}
        >
          <div className="w-full max-w-lg rounded-2xl border border-black/[0.08] bg-white p-5 shadow-2xl dark:border-line dark:bg-card">
            <h2 className="font-display text-sm font-bold">
              {pending === "delivery_resolved"
                ? "Confirm the customer actually received this data?"
                : "Queue this order for refund review?"}
            </h2>

            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl bg-black/[0.03] px-3 py-2.5 text-[12px] dark:bg-white/[0.04]">
              <dt className="opacity-55">Order</dt>
              <dd className="font-mono font-semibold">{order.ref}</dd>
              <dt className="opacity-55">Customer</dt>
              <dd>{order.customerName ?? "Customer not linked"}</dd>
              <dt className="opacity-55">Phone</dt>
              <dd className="font-mono">{order.phone}</dd>
              <dt className="opacity-55">Bundle</dt>
              <dd>{order.bundle}</dd>
              <dt className="opacity-55">Amount</dt>
              <dd className="tabular-nums">GHS {order.amount.toFixed(2)}</dd>
              <dt className="opacity-55">Status</dt>
              <dd className="capitalize">{order.status.replace(/_/g, " ")}</dd>
              <dt className="opacity-55">Failure info</dt>
              <dd className="leading-snug">{order.reason}</dd>
            </dl>

            <p className="mt-3 text-[12px] leading-relaxed opacity-70">
              {pending === "delivery_resolved" ? (
                <>
                  This marks the order <strong className="font-semibold">fulfilled</strong> in the
                  support queue because you have verified the data landed. It writes no money,
                  creates no ledger entry, credits no wallet and never contacts the provider.
                </>
              ) : (
                <>
                  This only records that a <strong className="font-semibold">refund review</strong>{" "}
                  is required. It does NOT refund anything — no wallet, deposit, Paystack or
                  ledger row is created, moved or reversed. Finance settles the refund outside
                  this dashboard.
                </>
              )}
            </p>

            <label className="mt-4 block">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
                Reason / context (optional)
              </span>
              <textarea
                value={reason}
                maxLength={240}
                onChange={(event) => setReason(event.target.value)}
                placeholder={
                  pending === "delivery_resolved"
                    ? "e.g. customer confirmed receipt on WhatsApp; provider ticket #4471 says delivered"
                    : "e.g. provider confirmed failure twice; refund per support policy"
                }
                className="h-16 w-full resize-none rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[13px] outline-none focus:border-brand dark:border-line dark:bg-card2"
              />
            </label>

            <label className="mt-3 block">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
                Type the order reference to confirm — <span className="font-mono normal-case">{order.ref}</span>
              </span>
              <input
                value={typedRef}
                onChange={(event) => setTypedRef(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={order.ref}
                className="h-9 w-full rounded-xl border border-black/[0.08] bg-white px-3 font-mono text-[13px] outline-none focus:border-brand dark:border-line dark:bg-card2"
              />
            </label>

            {error && (
              <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-[12px] text-rose-600 dark:text-rose-400">
                {error}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={busy}
                className="h-9 rounded-xl border border-black/[0.08] px-3 text-[12px] font-semibold opacity-70 hover:opacity-100 disabled:opacity-40 dark:border-line"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmAction()}
                disabled={busy || !matchesRef}
                className={
                  pending === "delivery_resolved"
                    ? "inline-flex h-9 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-[12px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                    : "inline-flex h-9 items-center gap-1.5 rounded-xl bg-amber-600 px-3 text-[12px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                }
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busy ? "Recording…" : ACTION_LABEL[pending]}
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && !pending && (
        <p className="mt-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">{notice}</p>
      )}
    </>
  );
}
