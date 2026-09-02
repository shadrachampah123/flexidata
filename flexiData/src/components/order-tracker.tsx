"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Loader2,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Signal,
  XCircle,
} from "lucide-react";
import type { TrackingInfo, TrackStage } from "@/lib/fulfillment";
import { formatEtaCountdown } from "@/lib/fulfillment";
import { cn, groupPhone, money } from "@/lib/format";

/** How often (ms) a live order re-checks the server for a status change. */
const POLL_INTERVAL_MS = 5_000;

function stateDotClasses(state: TrackStage["state"]): { ring: string; icon: React.ReactNode } {
  switch (state) {
    case "done":
      return {
        ring: "border-emerald-500 bg-emerald-500 text-white",
        icon: <CheckCircle2 className="h-4 w-4" strokeWidth={2.6} />,
      };
    case "current":
      return {
        ring: "border-brand bg-brand text-ink",
        icon: <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.8} />,
      };
    case "failed":
      return {
        ring: "border-rose-500 bg-rose-500 text-white",
        icon: <XCircle className="h-4 w-4" strokeWidth={2.6} />,
      };
    default:
      return {
        ring: "border-black/15 bg-transparent text-transparent dark:border-white/20",
        icon: <span className="h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-white/25" />,
      };
  }
}

function stageTime(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function PhaseHeader({ info }: { info: TrackingInfo }) {
  const conf = {
    processing: {
      icon: <Signal className="h-6 w-6" strokeWidth={2.2} />,
      cls: "bg-amber-500/15 text-amber-500",
      heading: info.overdue ? "Almost there" : "Delivering your order",
    },
    delivered: {
      icon: <PackageCheck className="h-6 w-6" strokeWidth={2.2} />,
      cls: "bg-emerald-500/15 text-emerald-500",
      heading: "Delivered",
    },
    failed: {
      icon: <XCircle className="h-6 w-6" strokeWidth={2.2} />,
      cls: "bg-rose-500/15 text-rose-500",
      heading: "Delivery failed",
    },
    refunded: {
      icon: <RotateCcw className="h-6 w-6" strokeWidth={2.2} />,
      cls: "bg-slate-500/15 text-slate-500",
      heading: "Order refunded",
    },
  }[info.phase];

  return (
    <div className="flex items-center gap-3.5">
      <span
        className={cn(
          "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl",
          conf.cls,
        )}
      >
        {conf.icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-display text-[17px] font-bold leading-tight tracking-tight">
          {conf.heading}
        </h2>
        <p className="truncate text-[12px] text-zinc-500 dark:text-zinc-400">{info.title}</p>
      </div>
    </div>
  );
}

/**
 * The ETA card. While an order is live this shows a ticking countdown to the
 * estimated delivery time; once terminal it shows how long delivery took (or
 * the failure/refund reason). This is the "how long before the data is
 * received" answer the customer is after.
 */
function EtaCard({ info, secondsLeft }: { info: TrackingInfo; secondsLeft: number | null }) {
  if (info.phase === "delivered") {
    return (
      <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3.5">
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-emerald-600 dark:text-emerald-400">
          Completed
        </p>
        <p className="mt-1 font-display text-[15px] font-bold">{info.etaLabel}</p>
      </div>
    );
  }

  if (info.phase === "failed" || info.phase === "refunded") {
    return (
      <div
        className={cn(
          "rounded-2xl border px-4 py-3.5",
          info.phase === "failed"
            ? "border-rose-500/25 bg-rose-500/[0.06]"
            : "border-slate-500/25 bg-slate-500/[0.06]",
        )}
      >
        <p
          className={cn(
            "text-[10px] font-black uppercase tracking-[0.14em]",
            info.phase === "failed" ? "text-rose-500" : "text-slate-500",
          )}
        >
          {info.phase === "failed" ? "Not completed" : "Reversed"}
        </p>
        <p className="mt-1 font-display text-[14px] font-bold">{info.etaLabel}</p>
        {info.providerMessage && (
          <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{info.providerMessage}</p>
        )}
      </div>
    );
  }

  // Live / processing.
  const countdown = formatEtaCountdown(secondsLeft, info.overdue);
  return (
    <div className="rounded-2xl border border-brand/30 bg-brand/[0.07] px-4 py-3.5">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-brand-deep dark:text-brand">
          <Clock3 className="h-3.5 w-3.5" />
          Estimated delivery
        </p>
        <span className="flex items-center gap-1 text-[10px] font-bold text-amber-600 dark:text-amber-400">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
          </span>
          Live
        </span>
      </div>
      <p className="mt-1 font-display text-[26px] font-bold tabular-nums leading-none tracking-tight">
        {countdown}
      </p>
      <p className="mt-1.5 text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
        {info.overdue
          ? "Taking a little longer than usual — hang tight."
          : "We'll update this automatically as your order moves."}
      </p>
    </div>
  );
}

function ProgressBar({ info }: { info: TrackingInfo }) {
  const barCls =
    info.phase === "delivered"
      ? "bg-emerald-500"
      : info.phase === "failed"
        ? "bg-rose-500"
        : info.phase === "refunded"
          ? "bg-slate-500"
          : "bg-brand";
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
        <span>Progress</span>
        <span className="tabular-nums">{info.progress}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10">
        <div
          className={cn("h-full rounded-full transition-[width] duration-700 ease-out", barCls)}
          style={{ width: `${info.progress}%` }}
        />
      </div>
    </div>
  );
}

function Timeline({ stages }: { stages: TrackStage[] }) {
  return (
    <ol className="relative">
      {stages.map((stage, i) => {
        const { ring, icon } = stateDotClasses(stage.state);
        const last = i === stages.length - 1;
        const connectorDone = stage.state === "done";
        const t = stageTime(stage.at);
        return (
          <li key={stage.id} className="relative flex gap-3.5 pb-5 last:pb-0">
            {!last && (
              <span
                className={cn(
                  "absolute left-[13px] top-7 h-[calc(100%-1.5rem)] w-0.5 rounded-full",
                  connectorDone ? "bg-emerald-500/40" : "bg-black/[0.08] dark:bg-white/10",
                )}
              />
            )}
            <span
              className={cn(
                "relative z-10 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                ring,
              )}
            >
              {icon}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-center justify-between gap-2">
                <p
                  className={cn(
                    "text-[13px] font-bold",
                    stage.state === "upcoming" && "text-zinc-400 dark:text-zinc-500",
                    stage.state === "failed" && "text-rose-500",
                  )}
                >
                  {stage.label}
                </p>
                {t && (
                  <span className="shrink-0 text-[10px] font-semibold tabular-nums text-zinc-400">
                    {t}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {stage.state === "current" ? "In progress…" : stage.hint}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function OrderTracker({
  initial,
  compact = false,
}: {
  initial: TrackingInfo;
  compact?: boolean;
}) {
  const [info, setInfo] = useState<TrackingInfo>(initial);
  // Local ticking clock so the countdown moves every second between polls.
  const [now, setNow] = useState<number>(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const infoRef = useRef(info);
  useEffect(() => {
    infoRef.current = info;
  }, [info]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/track/${encodeURIComponent(infoRef.current.ref)}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as { ok: boolean; tracking?: TrackingInfo; error?: string };
      if (data.ok && data.tracking) {
        setInfo(data.tracking);
        setNow(Date.now());
      } else if (data.error) {
        setError(data.error);
      }
    } catch {
      setError("Couldn't refresh right now.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Tick the countdown once a second while the order is live.
  useEffect(() => {
    if (!info.live) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [info.live]);

  // Poll the server for real status changes while the order is live.
  useEffect(() => {
    if (!info.live) return;
    const id = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [info.live, refresh]);

  // The stage/progress view only changes when the server reports a real update
  // (via polling), so we render `info` directly. The countdown, however, must
  // tick every second — recompute just the ETA fields against the live clock so
  // "Arriving in 40s" keeps moving without a network round-trip.
  const view = info;
  let secondsLeft = view.etaSeconds;
  let overdue = view.overdue;
  if (view.live && view.estimatedDeliveryAt) {
    const remaining = Math.round((new Date(view.estimatedDeliveryAt).getTime() - now) / 1000);
    secondsLeft = Math.max(0, remaining);
    overdue = remaining <= 0;
  }
  const liveView: TrackingInfo = { ...view, etaSeconds: secondsLeft, overdue };

  return (
    <div className="space-y-4">
      <PhaseHeader info={liveView} />

      <EtaCard info={liveView} secondsLeft={secondsLeft} />

      <ProgressBar info={liveView} />

      {!compact && (
        <div className="rounded-2xl border border-black/[0.06] bg-paper px-4 py-4 dark:border-line dark:bg-card">
          <Timeline stages={liveView.stages} />
        </div>
      )}
      {compact && (
        <div className="pt-1">
          <Timeline stages={liveView.stages} />
        </div>
      )}

      {/* Order meta */}
      <dl className="grid grid-cols-2 gap-2 text-[11px]">
        {liveView.recipient && (
          <Meta label="Recipient" value={groupPhone(liveView.recipient)} />
        )}
        {liveView.network && <Meta label="Network" value={liveView.network} />}
        <Meta label="Amount" value={money(liveView.amount)} />
        <Meta label="Attempts" value={String(liveView.attempts)} />
        <Meta label="Reference" value={liveView.ref} mono />
        {liveView.providerReference && (
          <Meta label="Provider ref" value={liveView.providerReference} mono />
        )}
      </dl>

      {liveView.live && (
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-black/[0.08] bg-paper py-3 text-[12px] font-bold transition-all hover:-translate-y-0.5 active:scale-[0.98] disabled:opacity-60 dark:border-line dark:bg-card"
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          {refreshing ? "Checking…" : "Check for updates"}
        </button>
      )}

      {error && (
        <p className="text-center text-[11px] font-semibold text-rose-500">{error}</p>
      )}
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-black/[0.05] bg-black/[0.02] px-3 py-2 dark:border-line dark:bg-white/[0.03]">
      <dt className="text-[9px] font-black uppercase tracking-[0.12em] text-zinc-400">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 truncate font-bold",
          mono ? "font-mono text-[11px]" : "text-[12px]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
