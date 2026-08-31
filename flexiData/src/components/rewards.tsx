"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Banknote,
  Flame,
  Gift,
  Smartphone,
  Sparkles,
  Users,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import type { WalletDTO } from "@/lib/data";
import type { RedeemOption } from "@/lib/constants";
import { FieldLabel } from "@/components/ui";
import { FlowSheet, type FlowResult } from "@/components/flow-sheet";
import { cn, fmtPoints, money } from "@/lib/format";

const KIND_ICON: Record<RedeemOption["kind"], { icon: LucideIcon; cls: string }> = {
  cash: { icon: Banknote, cls: "bg-emerald-500/15 text-emerald-500" },
  airtime: { icon: Smartphone, cls: "bg-violet-500/15 text-violet-500" },
  data: { icon: Wifi, cls: "bg-brand/15 text-brand-deep dark:text-brand" },
};

function tierOf(points: number) {
  if (points >= 3000) return { name: "Platinum", cls: "text-brand" };
  if (points >= 1500) return { name: "Gold", cls: "text-amber-400" };
  if (points >= 600) return { name: "Silver", cls: "text-zinc-300" };
  return { name: "Bronze", cls: "text-orange-300" };
}

export function Rewards({ wallet, options }: { wallet: WalletDTO; options: RedeemOption[] }) {
  const router = useRouter();
  const [points, setPoints] = useState(wallet.points);
  const [balance, setBalance] = useState(wallet.balance);
  const [selected, setSelected] = useState<RedeemOption | null>(null);
  const [phase, setPhase] = useState<"idle" | "confirm" | "processing" | "result">("idle");
  const [result, setResult] = useState<FlowResult | null>(null);

  const tier = tierOf(points);
  const next = options.filter((o) => o.cost > points).sort((a, b) => a.cost - b.cost)[0];
  const progress = next ? Math.min(100, Math.round((points / next.cost) * 100)) : 100;

  const submit = async () => {
    if (!selected) return;
    setPhase("processing");
    try {
      const res = await fetch("/api/rewards/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: selected.id }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        ref?: string;
        points?: number;
        balance?: number;
      };
      if (!data.ok) throw new Error(data.error ?? "Failed");
      if (typeof data.points === "number") setPoints(data.points);
      if (typeof data.balance === "number") setBalance(data.balance);
      setResult({
        status: "successful",
        ref: data.ref,
        headline: "Reward unlocked!",
        balance: selected.kind === "cash" ? data.balance : undefined,
        lines: [
          { label: "Reward", value: selected.label },
          { label: "Points spent", value: `− ${fmtPoints(selected.cost)} pts` },
          { label: "Points left", value: `${fmtPoints(data.points ?? 0)} pts` },
          ...(selected.kind === "cash"
            ? [{ label: "Wallet credited", value: money(selected.amount) }]
            : []),
        ],
      });
      setPhase("result");
      router.refresh();
    } catch (e) {
      setResult({
        status: "failed",
        headline: "Redemption failed",
        message: e instanceof Error ? e.message : "Something went wrong. Try again.",
      });
      setPhase("result");
    }
  };

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="wallet-sheen animate-fade-up relative overflow-hidden rounded-[2rem] border border-white/[0.08] p-5 text-white shadow-xl">
        <div className="pattern-dots pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 rounded-lg bg-white/10 px-2 py-1 text-[10px] font-black tracking-[0.18em] text-brand">
              <Sparkles className="h-3 w-3" /> QV POINTS
            </span>
            <span className={cn("text-[11px] font-black uppercase tracking-widest", tier.cls)}>
              {tier.name} tier
            </span>
          </div>
          <p className="font-display mt-4 text-[40px] font-bold leading-none tracking-tight tabular-nums">
            {fmtPoints(points)}
            <span className="ml-2 text-sm font-bold text-white/40">pts</span>
          </p>
          <p className="mt-1.5 text-[11px] text-white/50">
            ≈ {money(points / 60)} in wallet cash value • balance {money(balance)}
          </p>
          <div className="mt-4">
            <div className="flex justify-between text-[10px] font-bold text-white/50">
              <span>{next ? `${next.label}` : "All rewards unlocked"}</span>
              {next && <span>{progress}%</span>}
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-brand to-amber-400 transition-all duration-700"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* How to earn */}
      <div className="animate-fade-up" style={{ animationDelay: "80ms" }}>
        <FieldLabel>How you earn</FieldLabel>
        <div className="divide-y divide-black/[0.05] rounded-[1.4rem] border border-black/[0.05] bg-paper dark:divide-line dark:border-line dark:bg-card">
          {[
            { icon: Wifi, cls: "bg-brand/15 text-brand-deep dark:text-brand", t: "Buy data or airtime", s: "+2 pts for every GH₵ 1 spent" },
            { icon: Users, cls: "bg-sky-500/15 text-sky-500", t: "Refer friends", s: "+100 pts when they make their first purchase" },
            { icon: Flame, cls: "bg-rose-500/15 text-rose-500", t: "Weekly streaks", s: "+25 pts every 7-day run — coming soon" },
          ].map((r) => (
            <div key={r.t} className="flex items-center gap-3 px-4 py-3.5">
              <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl", r.cls)}>
                <r.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-bold">{r.t}</p>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{r.s}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Redeem */}
      <div className="animate-fade-up" style={{ animationDelay: "160ms" }}>
        <FieldLabel>Redeem points</FieldLabel>
        <div className="grid grid-cols-2 gap-2.5">
          {options.map((o) => {
            const conf = KIND_ICON[o.kind];
            const afford = points >= o.cost;
            const pct = Math.min(100, Math.round((points / o.cost) * 100));
            return (
              <button
                key={o.id}
                onClick={() => setSelected(o)}
                className="group rounded-[1.4rem] border border-black/[0.06] bg-paper p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand/40 active:scale-[0.97] dark:border-line dark:bg-card"
              >
                <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl", conf.cls)}>
                  <conf.icon className="h-4 w-4" />
                </span>
                <p className="mt-2.5 text-[13px] font-bold leading-tight">{o.label}</p>
                <p className="mt-0.5 flex items-center gap-1 text-[10px] font-black text-brand-deep dark:text-brand">
                  <Gift className="h-3 w-3" /> {fmtPoints(o.cost)} pts
                </p>
                <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                  <div
                    className={cn("h-full rounded-full", afford ? "bg-emerald-500" : "bg-brand/60")}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className={cn("mt-1.5 text-[9px] font-black tracking-wide", afford ? "text-emerald-500" : "text-zinc-400")}>
                  {afford ? "TAP TO REDEEM" : `${fmtPoints(o.cost - points)} PTS TO GO`}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      <FlowSheet
        open={phase !== "idle" || !!selected}
        phase={phase === "idle" ? "confirm" : phase}
        onClose={() => {
          setPhase("idle");
          setSelected(null);
        }}
        title="Redeem reward"
        rows={
          selected
            ? [
                { label: "Reward", value: selected.label },
                { label: "Cost", value: `${fmtPoints(selected.cost)} pts` },
                { label: "Balance after", value: `${fmtPoints(points - selected.cost)} pts` },
              ]
            : []
        }
        total={selected ? { label: "Pay", value: `${fmtPoints(selected.cost)} pts` } : undefined}
        ctaLabel="Redeem now"
        onConfirm={submit}
        processingSteps={["Checking your points…", "Applying reward…", "Updating your wallet…"]}
        result={result}
      />
    </div>
  );
}
