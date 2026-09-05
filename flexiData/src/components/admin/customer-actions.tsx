"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Ban, CircleCheck, Loader2 } from "lucide-react";

/**
 * Suspend / activate control for the customer detail page.
 *
 * This is the ONE deliberate write surface in the admin browser UI (Phase 2,
 * Step 1). It never changes anything on its own: a modal asks for an explicit
 * confirmation, and the request is only sent after the operator confirms, with
 * `confirm: true` and a fixed `action`. The API independently re-checks the
 * admin gate and refuses to act without `confirm: true`.
 *
 * Money-safety: the only request this component can make is the POST to the
 * customer-status endpoint, which touches `users.status` and `admin_audit_logs`
 * only. There is no wallet, deposit, transaction or order action here.
 */

type Status = "active" | "suspended";

export function CustomerActions({
  userId,
  name,
  status,
  isAdmin,
}: {
  userId: number;
  name: string;
  /** `null` means the database predates the migration; the control is hidden. */
  status: Status | null;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Administrator accounts are deliberately outside this control (one admin
  // must not be able to suspend another admin), and a pre-migration database
  // cannot store a status, so there is nothing to show.
  if (isAdmin || status === null) return null;

  const action: "suspend" | "activate" = status === "active" ? "suspend" : "activate";

  const confirmAction = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/users/${userId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, confirm: true, reason: reason.trim() || null }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;

      if (response.status === 404) {
        setError("This view is no longer available — your admin session may have ended.");
        return;
      }
      if (!response.ok || !payload?.ok) {
        setError(payload?.error ?? "The change could not be applied. Reload the page and try again.");
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
    } catch {
      setError("The request failed. Reload the page and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setReason("");
          setOpen(true);
        }}
        className={
          action === "suspend"
            ? "inline-flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[12px] font-semibold text-rose-600 transition-colors hover:bg-rose-500/15 dark:text-rose-400"
            : "inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[12px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400"
        }
      >
        {action === "suspend" ? <Ban className="h-3.5 w-3.5" /> : <CircleCheck className="h-3.5 w-3.5" />}
        {action === "suspend" ? "Suspend account" : "Activate account"}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={action === "suspend" ? "Confirm suspension" : "Confirm activation"}
        >
          <div className="w-full max-w-md rounded-2xl border border-black/[0.08] bg-white p-5 shadow-2xl dark:border-line dark:bg-card">
            <h2 className="font-display text-sm font-bold">
              {action === "suspend" ? "Suspend this customer?" : "Activate this customer?"}
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed opacity-70">
              {action === "suspend" ? (
                <>
                  <strong className="font-semibold">{name}</strong> will be blocked from taking new
                  actions — deposits, purchases, transfers, redemptions and scheduling — until an
                  administrator reactivates the account. Wallet balances, payments and the ledger
                  are never changed.
                </>
              ) : (
                <>
                  <strong className="font-semibold">{name}</strong> will be able to take actions
                  again. Nothing else changes.
                </>
              )}
            </p>

            <label className="mt-4 block">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
                Reason (optional)
              </span>
              <textarea
                value={reason}
                maxLength={240}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. fraud review — see ticket #123"
                className="h-20 w-full resize-none rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[13px] outline-none focus:border-brand dark:border-line dark:bg-card2"
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
                onClick={() => setOpen(false)}
                disabled={busy}
                className="h-9 rounded-xl border border-black/[0.08] px-3 text-[12px] font-semibold opacity-70 hover:opacity-100 disabled:opacity-40 dark:border-line"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmAction()}
                disabled={busy}
                className={
                  action === "suspend"
                    ? "inline-flex h-9 items-center gap-1.5 rounded-xl bg-rose-600 px-3 text-[12px] font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                    : "inline-flex h-9 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-[12px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                }
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {action === "suspend" ? "Confirm suspension" : "Confirm activation"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
