"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Copy, Eye, EyeOff, History, Nfc, Plus, SendHorizontal, Sparkles } from "lucide-react";
import type { WalletDTO } from "@/lib/data";
import { cn, fmtPoints, money } from "@/lib/format";

export function WalletCard({ wallet }: { wallet: WalletDTO }) {
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.number);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* noop */
    }
  };

  return (
    <section className="animate-fade-up">
      <div className="wallet-sheen relative overflow-hidden rounded-[2rem] border border-white/[0.08] p-5 text-white shadow-[0_20px_50px_rgba(10,10,15,0.45)]">
        <div className="pattern-dots pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="rounded-lg bg-white/10 px-2 py-1 text-[10px] font-black tracking-[0.18em] text-brand">
                FLEXIDATA WALLET
              </span>
              {wallet.isAgent && (
                <span className="rounded-lg bg-brand px-2 py-1 text-[10px] font-black tracking-[0.12em] text-ink">
                  {wallet.agentTier?.toUpperCase() ?? "AGENT"}
                </span>
              )}
            </div>
            <Nfc className="h-5 w-5 text-white/40" />
          </div>

          <div className="mt-6 flex items-center gap-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-white/50">
              Total balance
            </p>
            <button
              onClick={() => setHidden((h) => !h)}
              aria-label={hidden ? "Show balance" : "Hide balance"}
              className="text-white/50 transition-all hover:text-brand active:scale-90"
            >
              {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>

          <p className="font-display mt-1 text-[38px] font-bold leading-none tracking-tight tabular-nums">
            {hidden ? "GH₵ ••••••" : money(wallet.balance)}
          </p>

          <div className="mt-4 flex items-center gap-2">
            <span className="font-mono text-[13px] tracking-[0.16em] text-white/70">
              {wallet.number.replace(/(\d{3})(\d{3})(\d{4})/, "$1 $2 $3")}
            </span>
            <button
              onClick={copy}
              aria-label="Copy wallet number"
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10 text-white/70 transition-all hover:bg-white/20 hover:text-white active:scale-90"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <span className="ml-auto text-[10px] font-bold uppercase tracking-widest text-white/30">
              Ghana • GHS
            </span>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2">
            <QuickAction href="/wallet" icon={Plus} label="Fund" primary />
            <QuickAction href="/wallet?tab=transfer" icon={SendHorizontal} label="Transfer" />
            <QuickAction href="/history" icon={History} label="History" />
          </div>
        </div>
      </div>

      <Link
        href="/rewards"
        className="group mt-3 flex items-center gap-3 rounded-2xl border border-brand/25 bg-brand/[0.08] px-4 py-3 transition-all hover:bg-brand/[0.14] active:scale-[0.98]"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand text-ink">
          <Sparkles className="h-4 w-4" strokeWidth={2.4} />
        </span>
        <span className="flex-1 text-xs font-bold">
          <span className="font-display text-sm font-bold">{fmtPoints(wallet.points)} pts</span>
          <span className="text-zinc-500 dark:text-zinc-400"> — redeem for cash, data & airtime</span>
        </span>
        <ChevronRight className="h-4 w-4 text-zinc-400 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </section>
  );
}

function QuickAction({
  href,
  icon: Icon,
  label,
  primary,
}: {
  href: string;
  icon: typeof Plus;
  label: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-2xl border py-3 text-[11px] font-bold transition-all hover:-translate-y-0.5 active:scale-95",
        primary
          ? "border-brand bg-brand text-ink shadow-[0_8px_20px_rgba(255,203,5,0.3)]"
          : "border-white/10 bg-white/[0.07] text-white/90 backdrop-blur hover:bg-white/[0.12]",
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={2.4} />
      {label}
    </Link>
  );
}
