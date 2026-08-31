"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Clock3, Copy, Check, Loader2, Sparkles, XCircle } from "lucide-react";
import { Sheet } from "@/components/sheet";
import { cn, money } from "@/lib/format";

export type FlowStatus = "successful" | "pending" | "failed";

export type FlowResult = {
  status: FlowStatus;
  ref?: string;
  headline?: string;
  lines?: { label: string; value: string }[];
  pointsEarned?: number;
  balance?: number;
  message?: string;
};

export function FlowSheet({
  open,
  phase,
  onClose,
  title,
  rows,
  total,
  ctaLabel,
  onConfirm,
  processingSteps,
  result,
}: {
  open: boolean;
  phase: "confirm" | "processing" | "result";
  onClose: () => void;
  title: string;
  rows: { label: string; value: string }[];
  total?: { label: string; value: string };
  ctaLabel: string;
  onConfirm?: () => void;
  processingSteps?: string[];
  result: FlowResult | null;
}) {
  const steps = processingSteps ?? ["Contacting network…", "Verifying details…", "Finalising…"];

  const dismissible = phase !== "processing";
  const close = () => {
    if (dismissible) onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={phase === "result" ? "" : title}>
      {phase === "confirm" && (
        <div className="animate-fade-up -mt-2">
          <div className="rounded-2xl border border-black/[0.06] bg-black/[0.02] dark:border-line dark:bg-white/[0.03]">
            {rows.map((r) => (
              <div
                key={r.label}
                className="flex items-center justify-between border-b border-black/[0.05] px-4 py-3 last:border-0 dark:border-line"
              >
                <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{r.label}</span>
                <span className="max-w-[60%] truncate text-right text-[13px] font-bold">{r.value}</span>
              </div>
            ))}
            {total && (
              <div className="flex items-center justify-between bg-brand/10 px-4 py-3 dark:bg-brand/10">
                <span className="text-xs font-black uppercase tracking-wide text-brand-deep dark:text-brand">
                  {total.label}
                </span>
                <span className="font-display text-base font-bold text-brand-deep dark:text-brand">
                  {total.value}
                </span>
              </div>
            )}
          </div>
          <button
            onClick={onConfirm}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 font-display text-[15px] font-bold text-ink shadow-[0_12px_28px_rgba(255,203,5,0.35)] transition-all hover:-translate-y-0.5 active:scale-[0.98]"
          >
            <Sparkles className="h-4 w-4" strokeWidth={2.5} />
            {ctaLabel}
          </button>
          <p className="mt-3 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
            Secured by FlexiData Pay • Instant delivery
          </p>
        </div>
      )}

      {phase === "processing" && <ProcessingView steps={steps} />}

      {phase === "result" && result && <ResultView result={result} onClose={onClose} />}
    </Sheet>
  );
}

function ProcessingView({ steps }: { steps: string[] }) {
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setStepIdx((i) => (i + 1) % steps.length), 850);
    return () => clearInterval(id);
  }, [steps.length]);

  return (
    <div className="flex flex-col items-center py-10">
      <div className="relative">
        <Loader2 className="h-12 w-12 animate-spin text-brand" strokeWidth={2.2} />
        <span className="absolute inset-0 -m-2 rounded-full border-2 border-brand/20" />
      </div>
      <p key={stepIdx} className="animate-fade-up mt-6 text-sm font-bold">
        {steps[stepIdx]}
      </p>
      <p className="mt-1 text-xs text-zinc-400">Do not close this window</p>
      <div className="mt-6 h-1 w-40 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div className="h-full w-1/2 animate-[marquee_1.1s_linear_infinite] rounded-full bg-brand" />
      </div>
    </div>
  );
}

function ResultView({ result, onClose }: { result: FlowResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const ok = result.status === "successful";
  const pending = result.status === "pending";

  const copyRef = async () => {
    if (!result.ref) return;
    try {
      await navigator.clipboard.writeText(result.ref);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="flex flex-col items-center pt-1 text-center">
      <div
        className={cn(
          "animate-pop flex h-[72px] w-[72px] items-center justify-center rounded-full",
          ok && "animate-ring-pulse bg-brand/15 text-brand-deep dark:text-brand",
          pending && "bg-amber-500/15 text-amber-500",
          result.status === "failed" && "bg-rose-500/15 text-rose-500",
        )}
      >
        {ok && <CheckCircle2 className="h-9 w-9" strokeWidth={2.2} />}
        {pending && <Clock3 className="h-9 w-9" strokeWidth={2.2} />}
        {result.status === "failed" && <XCircle className="h-9 w-9" strokeWidth={2.2} />}
      </div>
      <h3 className="font-display mt-4 text-xl font-bold tracking-tight">
        {result.headline ??
          (ok ? "All done!" : pending ? "Processing" : "Something went wrong")}
      </h3>
      <p className="mt-1 max-w-[280px] text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        {result.message ??
          (ok
            ? "Your transaction completed successfully."
            : pending
              ? "The network is confirming this request. We'll update you shortly."
              : "This transaction could not be completed. You have not been charged.")}
      </p>

      {result.ref && (
        <button
          onClick={copyRef}
          className="mt-4 flex items-center gap-2 rounded-xl border border-black/[0.06] bg-black/[0.03] px-3 py-2 font-mono text-[11px] font-semibold tracking-wide transition-all hover:bg-black/[0.06] active:scale-95 dark:border-line dark:bg-white/[0.04]"
        >
          Ref: {result.ref}
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Copy className="h-3.5 w-3.5 text-zinc-400" />
          )}
        </button>
      )}

      {result.pointsEarned != null && result.pointsEarned > 0 && ok && (
        <div className="mt-3 rounded-full bg-brand/15 px-3 py-1 text-[11px] font-black text-brand-deep dark:text-brand">
          +{result.pointsEarned} pts earned
        </div>
      )}

      {result.lines && result.lines.length > 0 && (
        <div className="mt-4 w-full rounded-2xl border border-black/[0.06] dark:border-line">
          {result.lines.map((l) => (
            <div
              key={l.label}
              className="flex items-center justify-between border-b border-black/[0.05] px-4 py-2.5 text-xs last:border-0 dark:border-line"
            >
              <span className="font-semibold text-zinc-500 dark:text-zinc-400">{l.label}</span>
              <span className="font-bold">{l.value}</span>
            </div>
          ))}
        </div>
      )}

      {typeof result.balance === "number" && (
        <p className="mt-4 text-xs text-zinc-400">
          New balance: <span className="font-display font-bold text-zinc-700 dark:text-zinc-200">{money(result.balance)}</span>
        </p>
      )}

      <div className="mt-5 flex w-full gap-3">
        <Link
          href="/history"
          className="flex-1 rounded-2xl border border-black/10 py-3 text-center text-[13px] font-bold transition-all hover:bg-black/[0.03] active:scale-95 dark:border-line dark:hover:bg-white/[0.05]"
        >
          View history
        </Link>
        <button
          onClick={onClose}
          className="flex-1 rounded-2xl bg-brand py-3 text-[13px] font-bold text-ink transition-all hover:-translate-y-0.5 active:scale-95"
        >
          Done
        </button>
      </div>
    </div>
  );
}
