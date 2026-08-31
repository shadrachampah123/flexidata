"use client";

import { RotateCcw, Zap } from "lucide-react";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-ink shadow-[0_10px_24px_rgba(255,203,5,0.35)]">
        <Zap className="h-7 w-7" strokeWidth={2.4} />
      </span>
      <h2 className="font-display mt-5 text-xl font-bold tracking-tight">We hit a snag</h2>
      <p className="mt-1.5 max-w-[300px] text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        Something interrupted the connection. Your wallet is safe — try again.
      </p>
      <button
        onClick={reset}
        className="mt-5 flex items-center gap-2 rounded-2xl bg-brand px-5 py-3 text-[13px] font-bold text-ink transition-all hover:-translate-y-0.5 active:scale-95"
      >
        <RotateCcw className="h-4 w-4" />
        Try again
      </button>
    </div>
  );
}
