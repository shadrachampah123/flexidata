"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  BadgeCheck,
  Banknote,
  Check,
  Copy,
  Crown,
  Headset,
  Loader2,
  Rocket,
  Share2,
  Star,
  TrendingUp,
  Trophy,
  Users,
} from "lucide-react";
import type { AgentDTO, WalletDTO } from "@/lib/data";
import { AGENT_TIERS } from "@/lib/constants";
import { cn, money } from "@/lib/format";

export function Agent({ wallet, profile: initial }: { wallet: WalletDTO; profile: AgentDTO | null }) {
  const router = useRouter();
  const [profile, setProfile] = useState<AgentDTO | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const [justJoined, setJustJoined] = useState(false);

  const register = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/register", { method: "POST" });
      const data = (await res.json()) as { ok: boolean; error?: string; profile?: AgentDTO };
      if (!data.ok || !data.profile) throw new Error(data.error ?? "Failed");
      setProfile(data.profile);
      setJustJoined(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, kind: "link" | "code") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* noop */
    }
  };

  if (!profile) {
    return (
      <div className="space-y-5">
        <div className="wallet-sheen animate-fade-up relative overflow-hidden rounded-[2rem] border border-white/[0.08] p-6 text-white shadow-xl">
          <div className="pattern-dots pointer-events-none absolute inset-0 opacity-50" />
          <div className="relative">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-ink shadow-[0_10px_24px_rgba(255,203,5,0.4)]">
              <Rocket className="h-6 w-6" strokeWidth={2.2} />
            </span>
            <h2 className="font-display mt-4 text-2xl font-bold tracking-tight">
              Sell data.
              <br />
              Earn every day.
            </h2>
            <p className="mt-2 max-w-[300px] text-xs leading-relaxed text-white/60">
              Become an official QuickVend sub-agent. Buy at wholesale rates, resell at your own
              margin, and earn commission on every referral.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {["Wholesale rates", "Referral commission", "Dedicated support"].map((b) => (
                <span key={b} className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-bold text-white/80">
                  <BadgeCheck className="h-3 w-3 text-brand" /> {b}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="animate-fade-up space-y-2.5" style={{ animationDelay: "100ms" }}>
          {AGENT_TIERS.map((t, i) => (
            <div
              key={t.name}
              style={{ animationDelay: `${140 + i * 70}ms` }}
              className={cn(
                "animate-fade-up rounded-[1.6rem] border bg-paper p-4 shadow-sm dark:bg-card",
                i === 0 ? "border-brand/50 dark:border-brand/30" : "border-black/[0.05] dark:border-line",
              )}
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-xl",
                    i === 0 && "bg-brand text-ink",
                    i === 1 && "bg-sky-500/15 text-sky-500",
                    i === 2 && "bg-violet-500/15 text-violet-500",
                  )}
                >
                  {i === 0 ? <Star className="h-5 w-5" /> : i === 1 ? <TrendingUp className="h-5 w-5" /> : <Crown className="h-5 w-5" />}
                </span>
                <div className="flex-1">
                  <p className="font-display text-[15px] font-bold">
                    {t.name}
                    {i === 0 && (
                      <span className="ml-2 rounded-full bg-brand/15 px-2 py-0.5 text-[9px] font-black text-brand-deep dark:text-brand">
                        YOU START HERE
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t.blurb}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] font-bold">
                <span className="rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-white/[0.05]">
                  Data at <span className="text-emerald-500">{t.wholesale}</span>
                </span>
                <span className="rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-white/[0.05]">
                  Earn <span className="text-brand-deep dark:text-brand">{t.commission}</span>
                </span>
              </div>
            </div>
          ))}
        </div>

        {error && (
          <p className="animate-fade-up rounded-2xl bg-rose-500/10 px-4 py-2.5 text-center text-xs font-bold text-rose-500">
            {error}
          </p>
        )}

        <button
          onClick={register}
          disabled={busy}
          className="animate-fade-up flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 font-display text-[15px] font-bold text-ink shadow-[0_12px_28px_rgba(255,203,5,0.35)] transition-all hover:-translate-y-0.5 active:scale-[0.98] disabled:opacity-70"
          style={{ animationDelay: "380ms" }}
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Users className="h-5 w-5" strokeWidth={2.2} />}
          {busy ? "Activating…" : "Activate agent account — Free"}
        </button>
        <p className="text-center text-[10px] text-zinc-400">No registration fee • Instant approval • Cancel anytime</p>
      </div>
    );
  }

  const nextTier = AGENT_TIERS.find((t) => t.minReferrals > profile.referrals);
  const progressPct = nextTier ? Math.min(100, Math.round((profile.referrals / nextTier.minReferrals) * 100)) : 100;
  const link = `quickvend.app/r/${profile.referralCode.toLowerCase()}`;

  return (
    <div className="space-y-5">
      {justJoined && (
        <div className="animate-pop flex items-center gap-3 rounded-2xl bg-emerald-500/10 px-4 py-3 text-[12px] font-bold text-emerald-600 dark:text-emerald-400">
          <BadgeCheck className="h-5 w-5 shrink-0" />
          Welcome aboard, Agent! Your wholesale rates are now active.
        </div>
      )}

      {/* Referral card */}
      <div className="wallet-sheen animate-fade-up relative overflow-hidden rounded-[2rem] border border-white/[0.08] p-5 text-white shadow-xl">
        <div className="pattern-dots pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative">
          <div className="flex items-center justify-between">
            <span className="rounded-lg bg-brand px-2 py-1 text-[10px] font-black tracking-[0.18em] text-ink">
              {profile.tier.toUpperCase()} AGENT
            </span>
            <Trophy className="h-5 w-5 text-brand/70" />
          </div>
          <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">
            Your referral link
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-xl bg-white/10 px-3 py-2.5 font-mono text-[13px] font-semibold text-brand">
              {link}
            </span>
            <button
              onClick={() => copy(link, "link")}
              aria-label="Copy referral link"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand text-ink transition-all hover:-translate-y-0.5 active:scale-90"
            >
              {copied === "link" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-white/50">
            <span>
              Agent code:{" "}
              <button
                onClick={() => copy(profile.referralCode, "code")}
                className="font-mono font-bold text-white/80 underline decoration-dotted underline-offset-2"
              >
                {copied === "code" ? "Copied!" : profile.referralCode}
              </button>
            </span>
            <span>+100 pts & 3% per referral</span>
          </div>
          <button className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.07] py-2.5 text-xs font-bold transition-all hover:bg-white/[0.12] active:scale-[0.98]">
            <Share2 className="h-4 w-4" /> Share your link
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="animate-fade-up grid grid-cols-3 gap-2.5" style={{ animationDelay: "100ms" }}>
        {[
          { icon: Users, label: "Referrals", value: String(profile.referrals), cls: "bg-sky-500/15 text-sky-500" },
          { icon: Banknote, label: "Commission", value: money(profile.commission), cls: "bg-emerald-500/15 text-emerald-500" },
          { icon: TrendingUp, label: "Volume / mo", value: money(profile.volume), cls: "bg-violet-500/15 text-violet-500" },
        ].map((s) => (
          <div key={s.label} className="rounded-[1.4rem] border border-black/[0.05] bg-paper p-3.5 shadow-sm dark:border-line dark:bg-card">
            <span className={cn("flex h-8 w-8 items-center justify-center rounded-xl", s.cls)}>
              <s.icon className="h-4 w-4" />
            </span>
            <p className="font-display mt-2 truncate text-[15px] font-bold tracking-tight">{s.value}</p>
            <p className="text-[10px] font-semibold text-zinc-400">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Progress */}
      {nextTier && (
        <div className="animate-fade-up rounded-[1.6rem] border border-black/[0.05] bg-paper p-4 shadow-sm dark:border-line dark:bg-card" style={{ animationDelay: "160ms" }}>
          <div className="flex items-center justify-between text-xs font-bold">
            <span>Progress to {nextTier.name}</span>
            <span className="text-zinc-400">
              {profile.referrals}/{nextTier.minReferrals} referrals
            </span>
          </div>
          <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand to-amber-400 transition-all duration-700"
              style={{ width: `${Math.max(4, progressPct)}%` }}
            />
          </div>
          <p className="mt-2 text-[10px] font-semibold text-zinc-400">
            {nextTier.name} unlocks data at {nextTier.wholesale} and {nextTier.commission}.
          </p>
        </div>
      )}

      {/* Benefits */}
      <div className="animate-fade-up" style={{ animationDelay: "220ms" }}>
        <div className="divide-y divide-black/[0.05] rounded-[1.6rem] border border-black/[0.05] bg-paper dark:divide-line dark:border-line dark:bg-card">
          {[
            { icon: BadgeCheck, t: "Wholesale data rates active", s: "Buy up to 14% below retail on MTN & Telecel" },
            { icon: Banknote, t: "Referral commissions", s: "Earn a cut on every purchase your referrals make" },
            { icon: Headset, t: "Dedicated support line", s: "Priority resolution for you and your customers" },
          ].map((b) => (
            <div key={b.t} className="flex items-center gap-3 px-4 py-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand-deep dark:text-brand">
                <b.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-bold">{b.t}</p>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{b.s}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
