"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Clock3,
  Loader2,
  Radar,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Card } from "@/components/ui";
import { cn, money } from "@/lib/format";

type OrderSummary = {
  ref: string;
  paymentStatus: "pending" | "successful" | "failed" | "abandoned";
  orderStatus:
    | "awaiting_payment"
    | "payment_failed"
    | "abandoned"
    | "paid"
    | "fulfilling"
    | "fulfilled"
    | "fulfillment_failed";
  fulfillmentStatus: string;
  network: string;
  planLabel: string;
  recipient: string;
  amount: number;
  currency: string;
  providerMessage: string | null;
};

const POLL_MS = 4000;
const MAX_POLLS = 20; // ~80s of automatic polling, then manual refresh.

/**
 * Client half of the Paystack return page. Repeatedly asks the server to
 * verify the charge with Paystack (POST /api/checkout/verify) and renders
 * pending / success / failed / abandoned states. All decisions about the
 * payment happen server-side; this component only displays them.
 */
export function CheckoutResult({ orderRef }: { orderRef: string }) {
  const [order, setOrder] = useState<OrderSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  // Bumping this restarts the polling loop (the "Check again" button).
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polls = 0;

    const isSettled = (o: OrderSummary) =>
      o.orderStatus === "fulfilled" ||
      o.orderStatus === "fulfillment_failed" ||
      o.paymentStatus === "failed" ||
      o.paymentStatus === "abandoned";

    async function run() {
      setChecking(true);
      setError(null);
      try {
        const res = await fetch("/api/checkout/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref: orderRef }),
        });
        const data = (await res.json()) as { ok: boolean; order?: OrderSummary; error?: string };
        if (cancelled) return;
        if (!data.ok || !data.order) {
          setError(data.error ?? "Could not check the payment status.");
        } else {
          setOrder(data.order);
          if (!isSettled(data.order) && polls < MAX_POLLS) {
            polls += 1;
            timer = setTimeout(() => void run(), POLL_MS);
          }
        }
      } catch {
        if (!cancelled) setError("Network problem while checking the payment. Try again.");
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderRef, attempt]);

  const check = (manual = false) => {
    void manual;
    setAttempt((a) => a + 1);
  };

  const phase: "checking" | "success" | "processing" | "pending" | "failed" | "abandoned" = !order
    ? "checking"
    : order.orderStatus === "fulfilled"
      ? "success"
      : order.orderStatus === "fulfilling" || order.orderStatus === "paid"
        ? "processing"
        : order.paymentStatus === "failed" || order.orderStatus === "fulfillment_failed"
          ? "failed"
          : order.paymentStatus === "abandoned"
            ? "abandoned"
            : "pending";

  const headline =
    phase === "checking"
      ? "Confirming your payment…"
      : phase === "success"
        ? "Bundle delivered!"
        : phase === "processing"
          ? "Payment received — sending your bundle"
          : phase === "pending"
            ? "Waiting for your payment"
            : phase === "abandoned"
              ? "Checkout not completed"
              : order?.orderStatus === "fulfillment_failed"
                ? "Paid — delivery needs attention"
                : "Payment failed";

  const sub =
    phase === "checking"
      ? "We are verifying the transaction directly with Paystack."
      : phase === "success"
        ? "Your data bundle is on its way to the recipient's phone."
        : phase === "processing"
          ? "Paystack confirmed your payment. The bundle is being delivered now."
          : phase === "pending"
            ? "Complete the payment in the Paystack window, then check again here."
            : phase === "abandoned"
              ? "You left before paying. No money was taken — you can start the purchase again."
              : order?.orderStatus === "fulfillment_failed"
                ? order?.providerMessage ??
                  "Your payment is confirmed but delivery hit a snag. Support will fulfil or refund this order."
                : "The payment did not go through. You were not charged — please try again.";

  return (
    <div className="space-y-4">
      <Card className="animate-fade-up p-6 text-center">
        <div
          className={cn(
            "mx-auto flex h-16 w-16 items-center justify-center rounded-full",
            phase === "success" && "bg-emerald-500/15 text-emerald-500",
            phase === "processing" && "bg-brand/15 text-brand-deep dark:text-brand",
            (phase === "checking" || phase === "pending") && "bg-sky-500/15 text-sky-500",
            (phase === "failed" || phase === "abandoned") && "bg-rose-500/15 text-rose-500",
          )}
        >
          {phase === "checking" && <Loader2 className="h-8 w-8 animate-spin" />}
          {phase === "success" && <CheckCircle2 className="h-8 w-8" />}
          {phase === "processing" && <Radar className="h-8 w-8 animate-pulse" />}
          {phase === "pending" && <Clock3 className="h-8 w-8" />}
          {(phase === "failed" || phase === "abandoned") && <XCircle className="h-8 w-8" />}
        </div>

        <h2 className="font-display mt-4 text-[20px] font-bold tracking-tight">{headline}</h2>
        <p className="mx-auto mt-1 max-w-sm text-[12px] text-zinc-500 dark:text-zinc-400">{sub}</p>

        {error && (
          <p className="mx-auto mt-3 max-w-sm rounded-xl bg-rose-500/10 px-3 py-2 text-[11px] font-semibold text-rose-500">
            {error}
          </p>
        )}

        {order && (
          <div className="mx-auto mt-5 max-w-sm space-y-2 rounded-2xl border border-black/[0.06] bg-black/[0.02] p-4 text-left text-[12px] dark:border-line dark:bg-white/[0.03]">
            <Row label="Bundle" value={`${order.network} ${order.planLabel}`} />
            <Row label="Recipient" value={order.recipient} />
            <Row label="Amount" value={money(order.amount)} />
            <Row label="Reference" value={order.ref} mono />
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          {(phase === "pending" || phase === "processing" || phase === "checking") && (
            <button
              onClick={() => check(true)}
              disabled={checking}
              className="flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-[12px] font-bold text-ink transition-all hover:-translate-y-0.5 active:scale-95 disabled:opacity-60"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} />
              Check again
            </button>
          )}
          {(phase === "success" || phase === "processing") && order && (
            <Link
              href={`/track/${encodeURIComponent(order.ref)}`}
              className="rounded-xl bg-ink px-4 py-2.5 text-[12px] font-bold text-white transition-all hover:-translate-y-0.5 active:scale-95 dark:bg-white dark:text-ink"
            >
              Track delivery
            </Link>
          )}
          {(phase === "failed" || phase === "abandoned") && (
            <Link
              href="/data"
              className="rounded-xl bg-brand px-4 py-2.5 text-[12px] font-bold text-ink transition-all hover:-translate-y-0.5 active:scale-95"
            >
              Try again
            </Link>
          )}
          <Link
            href="/history"
            className="rounded-xl border border-black/[0.08] px-4 py-2.5 text-[12px] font-bold transition-all hover:-translate-y-0.5 active:scale-95 dark:border-line"
          >
            View history
          </Link>
        </div>
      </Card>

      <div
        className="animate-fade-up flex items-start gap-2.5 rounded-2xl border border-black/[0.06] bg-black/[0.02] px-4 py-3 text-[11px] text-zinc-500 dark:border-line dark:bg-white/[0.03] dark:text-zinc-400"
        style={{ animationDelay: "80ms" }}
      >
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-deep dark:text-brand" />
        <p>
          Payments are processed securely by Paystack. FlexiData never sees your card or mobile
          money PIN, and a bundle is only sent after Paystack confirms the payment.
        </p>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-semibold text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className={cn("truncate font-bold", mono && "font-mono text-[11px]")}>{value}</span>
    </div>
  );
}
