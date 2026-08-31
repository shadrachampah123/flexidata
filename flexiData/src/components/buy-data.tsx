"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BadgePercent,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Layers,
  TriangleAlert,
  Users,
} from "lucide-react";
import type { PlanDTO, WalletDTO } from "@/lib/data";
import type { BundleCategory, Network } from "@/lib/constants";
import { NETWORKS } from "@/lib/constants";
import { Segmented, FieldLabel, NetworkBadge } from "@/components/ui";
import { PhoneInput } from "@/components/phone-input";
import { FlowSheet, type FlowResult } from "@/components/flow-sheet";
import { DropdownPanel } from "@/components/dropdown-panel";
import { cn, groupPhone, isValidPhone, money } from "@/lib/format";

export function BuyData({
  wallet,
  plans,
  categories,
}: {
  wallet: WalletDTO;
  plans: PlanDTO[];
  categories: BundleCategory[];
}) {
  const router = useRouter();
  const [network, setNetwork] = useState<Network>("MTN");
  const [category, setCategory] = useState("");
  const [planId, setPlanId] = useState<number | null>(null);
  const [phone, setPhone] = useState("");
  const [dropOpen, setDropOpen] = useState(false);
  const catTriggerRef = useRef<HTMLButtonElement>(null);
  const closeDrop = useCallback(() => setDropOpen(false), []);
  const [balance, setBalance] = useState(wallet.balance);

  const [phase, setPhase] = useState<"idle" | "confirm" | "processing" | "result">("idle");
  const [result, setResult] = useState<FlowResult | null>(null);

  const cats = useMemo(() => categories.filter((c) => c.network === network), [categories, network]);
  const activeCat = cats.find((c) => c.id === category) ?? cats[0];
  const filtered = useMemo(
    () => plans.filter((p) => p.network === network && p.category === activeCat?.id),
    [plans, network, activeCat],
  );
  const plan = filtered.find((p) => p.id === planId) ?? null;

  const switchNetwork = (id: string) => {
    setNetwork(id as Network);
    setCategory("");
    setPlanId(null);
    setDropOpen(false);
  };

  const savePct = plan ? Math.max(0, Math.round((1 - plan.price / plan.retail) * 100)) : 0;
  const insufficient = plan ? balance < plan.price : false;
  const ready = !!plan && isValidPhone(phone) && !insufficient;

  const submit = async () => {
    if (!plan) return;
    setPhase("processing");
    try {
      const res = await fetch("/api/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "data",
          network,
          category: activeCat?.id,
          planLabel: plan.label,
          recipient: phone,
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        status?: string;
        ref?: string;
        pointsEarned?: number;
        balance?: number;
      };
      if (data.error === "insufficient_funds") {
        setResult({
          status: "failed",
          headline: "Insufficient balance",
          message: "Top up your wallet and try again.",
        });
        setPhase("result");
        return;
      }
      if (!data.ok) throw new Error(data.error ?? "Failed");
      if (typeof data.balance === "number") setBalance(data.balance);
      setResult({
        status: (data.status as FlowResult["status"]) ?? "successful",
        ref: data.ref,
        headline:
          data.status === "successful"
            ? `${plan.label} sent!`
            : data.status === "pending"
              ? "Bundle processing"
              : "Purchase failed",
        pointsEarned: data.pointsEarned,
        balance: data.balance,
        lines: [
          { label: "Bundle", value: `${network} ${plan.label}` },
          { label: "Recipient", value: groupPhone(phone) },
          { label: "You paid", value: money(plan.price) },
        ],
      });
      setPhase("result");
      router.refresh();
    } catch (e) {
      setResult({
        status: "failed",
        headline: "Purchase failed",
        message: e instanceof Error ? e.message : "Something went wrong. Try again.",
      });
      setPhase("result");
    }
  };

  return (
    <div className="space-y-5">
      {/* Network */}
      <div className="animate-fade-up">
        <FieldLabel>Network</FieldLabel>
        <Segmented
          options={NETWORKS.map((n) => ({ id: n.id, label: n.label, dot: n.dot }))}
          value={network}
          onChange={switchNetwork}
        />
      </div>

      {/* Category dropdown */}
      <div className="animate-fade-up relative" style={{ animationDelay: "60ms" }}>
        <FieldLabel>Bundle category</FieldLabel>
        <button
          ref={catTriggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={dropOpen}
          onClick={() => setDropOpen((o) => !o)}
          className={cn(
            "flex w-full items-center gap-3 rounded-2xl border bg-paper px-4 py-3 text-left transition-all active:scale-[0.99] dark:bg-card",
            dropOpen ? "border-brand ring-2 ring-brand/30" : "border-black/[0.08] dark:border-line",
          )}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand-deep dark:text-brand">
            <Layers className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-bold">{activeCat?.label}</span>
            <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {activeCat?.hint}
            </span>
          </span>
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-zinc-400 transition-transform", dropOpen && "rotate-180")}
          />
        </button>
        <DropdownPanel
          open={dropOpen}
          anchorRef={catTriggerRef}
          onClose={closeDrop}
          label="Bundle category"
          maxHeight={340}
        >
          <ul>
            {cats.map((c) => (
              <li key={c.id}>
                <button
                  role="option"
                  aria-selected={c.id === activeCat?.id}
                  onClick={() => {
                    setCategory(c.id);
                    setPlanId(null);
                    setDropOpen(false);
                  }}
                  className="flex w-full items-center gap-3 border-b border-black/[0.04] px-4 py-3 text-left transition-colors last:border-0 hover:bg-black/[0.03] dark:border-line dark:hover:bg-white/[0.04]"
                >
                  <span
                    className={cn(
                      "h-2.5 w-2.5 shrink-0 rounded-full border-2",
                      c.id === activeCat?.id
                        ? "border-brand bg-brand"
                        : "border-zinc-300 bg-transparent dark:border-zinc-600",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-bold">{c.label}</span>
                    <span className="block truncate text-[10px] text-zinc-500">{c.hint}</span>
                  </span>
                  {c.id === activeCat?.id && (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-brand-deep dark:text-brand" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </DropdownPanel>
      </div>

      {/* Bundles */}
      <div className="animate-fade-up" style={{ animationDelay: "120ms" }}>
        <div className="mb-2 flex items-center justify-between">
          <FieldLabel>Select bundle</FieldLabel>
          <NetworkBadge network={network} />
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {filtered.map((p) => {
            const active = p.id === planId;
            const pct = Math.max(0, Math.round((1 - p.price / p.retail) * 100));
            return (
              <button
                key={p.id}
                onClick={() => setPlanId(p.id)}
                className={cn(
                  "relative rounded-[1.4rem] border p-4 text-left transition-all active:scale-[0.97]",
                  active
                    ? "border-brand bg-brand/[0.08] ring-2 ring-brand/50"
                    : "border-black/[0.06] bg-paper shadow-sm hover:-translate-y-0.5 hover:border-brand/40 dark:border-line dark:bg-card",
                )}
              >
                {p.badge && (
                  <span
                    className={cn(
                      "absolute -top-2 right-3 rounded-full px-2 py-0.5 text-[8px] font-black tracking-wider text-white",
                      p.badge === "HOT" ? "bg-rose-500" : p.badge === "B2B" ? "bg-sky-500" : "bg-amber-500",
                    )}
                  >
                    {p.badge}
                  </span>
                )}
                {active && (
                  <CheckCircle2 className="animate-pop absolute right-3 top-3 h-4 w-4 text-brand-deep dark:text-brand" />
                )}
                <p className="font-display text-[17px] font-bold tracking-tight">{p.label}</p>
                <p className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold text-zinc-400">
                  <CalendarDays className="h-3 w-3" /> {p.validity}
                </p>
                <div className="mt-2.5 flex items-baseline gap-1.5">
                  <span className="font-display text-[15px] font-bold text-brand-deep dark:text-brand">
                    {money(p.price)}
                  </span>
                  <span className="text-[10px] font-semibold text-zinc-400 line-through">
                    {money(p.retail)}
                  </span>
                </div>
                {pct > 0 && (
                  <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-black text-emerald-600 dark:text-emerald-400">
                    <BadgePercent className="h-3 w-3" /> SAVE {pct}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {!wallet.isAgent && (
          <Link
            href="/agent"
            className="mt-3 flex items-center gap-2 rounded-2xl border border-dashed border-brand/40 bg-brand/[0.05] px-3.5 py-2.5 text-[11px] font-bold text-zinc-600 transition-colors hover:bg-brand/10 dark:text-zinc-300"
          >
            <Users className="h-4 w-4 shrink-0 text-brand-deep dark:text-brand" />
            Become an agent and unlock wholesale rates up to 14% lower
            <span className="ml-auto text-brand-deep dark:text-brand">Join →</span>
          </Link>
        )}
      </div>

      {/* Recipient */}
      <div className="animate-fade-up" style={{ animationDelay: "180ms" }}>
        <PhoneInput value={phone} onChange={setPhone} />
      </div>

      {/* Sticky CTA */}
      <div className="animate-fade-up sticky bottom-[78px] z-30 md:bottom-4" style={{ animationDelay: "240ms" }}>
        <div className="flex items-center gap-3 rounded-[1.4rem] border border-black/[0.06] bg-[#14161c] p-3 pl-4 text-white shadow-[0_16px_40px_rgba(0,0,0,0.35)] dark:border-line">
          <div className="min-w-0 flex-1">
            {plan ? (
              <>
                <p className="font-display truncate text-[14px] font-bold">
                  {plan.label} <span className="text-white/50">•</span> {money(plan.price)}
                </p>
                <p className={cn("text-[10px] font-semibold", insufficient ? "text-amber-400" : "text-white/50")}>
                  Balance {money(balance)}
                  {savePct > 0 && !insufficient && ` • you save ${savePct}%`}
                </p>
              </>
            ) : (
              <>
                <p className="font-display text-[14px] font-bold">Select a bundle</p>
                <p className="text-[10px] font-semibold text-white/50">Balance {money(balance)}</p>
              </>
            )}
          </div>
          {insufficient ? (
            <Link
              href="/wallet"
              className="flex items-center gap-1.5 rounded-xl bg-amber-400 px-4 py-3 text-[12px] font-bold text-ink transition-all hover:-translate-y-0.5 active:scale-95"
            >
              <TriangleAlert className="h-3.5 w-3.5" /> Fund wallet
            </Link>
          ) : (
            <button
              disabled={!ready}
              onClick={() => setPhase("confirm")}
              className={cn(
                "rounded-xl px-5 py-3 text-[12px] font-bold transition-all",
                ready
                  ? "bg-brand text-ink shadow-[0_8px_20px_rgba(255,203,5,0.35)] hover:-translate-y-0.5 active:scale-95"
                  : "cursor-not-allowed bg-white/10 text-white/40",
              )}
            >
              Buy now
            </button>
          )}
        </div>
      </div>

      <FlowSheet
        open={phase !== "idle"}
        phase={phase === "idle" ? "confirm" : phase}
        onClose={() => setPhase("idle")}
        title="Confirm purchase"
        rows={
          plan
            ? [
                { label: "Bundle", value: `${network} ${plan.label}` },
                { label: "Category", value: activeCat?.label ?? "" },
                { label: "Recipient", value: groupPhone(phone) },
                { label: "Validity", value: plan.validity },
                { label: "You save", value: `${savePct}% off retail (${money(plan.retail)})` },
              ]
            : []
        }
        total={plan ? { label: "You pay", value: money(plan.price) } : undefined}
        ctaLabel={`Pay ${plan ? money(plan.price) : ""}`}
        onConfirm={submit}
        processingSteps={[
          `Contacting ${network}…`,
          "Reserving your bundle…",
          "Delivering to recipient…",
        ]}
        result={result}
      />
    </div>
  );
}
