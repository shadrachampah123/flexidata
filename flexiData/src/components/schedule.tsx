"use client";

import { useState } from "react";
import {
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Layers,
  Repeat2,
  Trash2,
} from "lucide-react";
import type { PlanDTO, ScheduleDTO } from "@/lib/data";
import { NETWORKS, type Network } from "@/lib/constants";
import { Segmented, FieldLabel } from "@/components/ui";
import { PhoneInput } from "@/components/phone-input";
import { FlowSheet, type FlowResult } from "@/components/flow-sheet";
import { cn, groupPhone, isValidPhone, money, ordinal } from "@/lib/format";

export function Schedule({ schedules: initial, plans }: { schedules: ScheduleDTO[]; plans: PlanDTO[] }) {
  const [items, setItems] = useState(initial);
  const [network, setNetwork] = useState<Network>("MTN");
  const [planId, setPlanId] = useState<number | null>(null);
  const [phone, setPhone] = useState("");
  const [day, setDay] = useState(1);
  const [dropOpen, setDropOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "confirm" | "processing" | "result">("idle");
  const [result, setResult] = useState<FlowResult | null>(null);

  const networkPlans = plans.filter((p) => p.network === network);
  const plan = networkPlans.find((p) => p.id === planId) ?? null;
  const ready = !!plan && isValidPhone(phone);

  const toggle = async (id: number, active: boolean) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, active } : x)));
    try {
      await fetch("/api/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, active }),
      });
    } catch {
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, active: !active } : x)));
    }
  };

  const remove = async (id: number) => {
    const prev = items;
    setItems((xs) => xs.filter((x) => x.id !== id));
    try {
      await fetch("/api/schedule", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch {
      setItems(prev);
    }
  };

  const submit = async () => {
    if (!plan) return;
    setPhase("processing");
    try {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network,
          planLabel: plan.label,
          price: plan.price,
          recipient: phone,
          dayOfMonth: day,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; schedule?: ScheduleDTO };
      if (!data.ok || !data.schedule) throw new Error(data.error ?? "Failed");
      setItems((xs) => [...xs, data.schedule!].sort((a, b) => a.dayOfMonth - b.dayOfMonth));
      setResult({
        status: "successful",
        headline: "Auto top-up scheduled!",
        message: `We'll charge your wallet and deliver ${plan.label} every ${ordinal(
          data.schedule.dayOfMonth,
        )} of the month.`,
        lines: [
          { label: "Bundle", value: `${network} ${plan.label}` },
          { label: "Recipient", value: groupPhone(data.schedule.recipient) },
          { label: "Repeats", value: `Every ${ordinal(data.schedule.dayOfMonth)} monthly` },
          { label: "Auto-charge", value: money(data.schedule.price) },
        ],
      });
      setPhase("result");
      setPlanId(null);
      setPhone("");
    } catch (e) {
      setResult({
        status: "failed",
        headline: "Couldn't schedule",
        message: e instanceof Error ? e.message : "Something went wrong. Try again.",
      });
      setPhase("result");
    }
  };

  return (
    <div className="space-y-6">
      {/* Existing schedules */}
      {items.length > 0 && (
        <div className="animate-fade-up">
          <FieldLabel>Your recurring top-ups</FieldLabel>
          <div className="space-y-2.5">
            {items.map((s, i) => (
              <div
                key={s.id}
                style={{ animationDelay: `${i * 60}ms` }}
                className={cn(
                  "animate-fade-up flex items-center gap-3 rounded-[1.4rem] border bg-paper p-4 shadow-sm transition-all dark:bg-card",
                  s.active ? "border-black/[0.05] dark:border-line" : "border-black/[0.04] opacity-60 dark:border-line",
                )}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-500 dark:text-indigo-400">
                  <CalendarClock className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-bold">
                    {s.network} {s.planLabel}
                  </span>
                  <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    → {groupPhone(s.recipient)} • every {ordinal(s.dayOfMonth)} • {money(s.price)}
                  </span>
                </span>
                <button
                  onClick={() => toggle(s.id, !s.active)}
                  aria-label={s.active ? "Pause" : "Resume"}
                  aria-pressed={s.active}
                  className={cn(
                    "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                    s.active ? "bg-brand" : "bg-zinc-300 dark:bg-zinc-700",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
                      s.active ? "left-[22px]" : "left-0.5",
                    )}
                  />
                </button>
                <button
                  onClick={() => remove(s.id)}
                  aria-label="Delete schedule"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition-all hover:bg-rose-500/10 hover:text-rose-500 active:scale-90"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create form */}
      <div className="animate-fade-up rounded-[1.75rem] border border-black/[0.05] bg-paper p-4 shadow-sm dark:border-line dark:bg-card" style={{ animationDelay: "120ms" }}>
        <div className="mb-4 flex items-center gap-2 px-1">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand/15 text-brand-deep dark:text-brand">
            <Repeat2 className="h-4 w-4" />
          </span>
          <div>
            <p className="font-display text-sm font-bold">New auto top-up</p>
            <p className="text-[10px] text-zinc-400">Never run out of data again</p>
          </div>
        </div>

        <div className="space-y-4">
          <Segmented
            options={NETWORKS.map((n) => ({ id: n.id, label: n.label, dot: n.dot }))}
            value={network}
            onChange={(id) => {
              setNetwork(id as Network);
              setPlanId(null);
            }}
          />

          {/* Plan picker */}
          <div className="relative">
            <FieldLabel>Bundle</FieldLabel>
            <button
              type="button"
              onClick={() => setDropOpen((o) => !o)}
              className={cn(
                "flex w-full items-center gap-3 rounded-2xl border bg-black/[0.02] px-4 py-3 text-left transition-all dark:bg-white/[0.03]",
                dropOpen ? "border-brand ring-2 ring-brand/30" : "border-black/[0.08] dark:border-line",
              )}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand-deep dark:text-brand">
                <Layers className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-bold">
                  {plan ? `${plan.label} — ${money(plan.price)}` : "Choose a bundle"}
                </span>
                <span className="block text-[10px] text-zinc-500">
                  {plan ? `${plan.validity} • saves vs ${money(plan.retail)}` : `${networkPlans.length} options on ${network}`}
                </span>
              </span>
              <ChevronDown className={cn("h-4 w-4 shrink-0 text-zinc-400 transition-transform", dropOpen && "rotate-180")} />
            </button>
            {dropOpen && (
              <>
                <button aria-label="Close" onClick={() => setDropOpen(false)} className="fixed inset-0 z-40 cursor-default" />
                <ul className="animate-fade-up absolute inset-x-0 top-[calc(100%+6px)] z-50 max-h-[260px] overflow-y-auto rounded-2xl border border-black/[0.06] bg-paper shadow-[0_20px_50px_rgba(0,0,0,0.18)] dark:border-line dark:bg-card2">
                  {networkPlans.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => {
                          setPlanId(p.id);
                          setDropOpen(false);
                        }}
                        className="flex w-full items-center gap-3 border-b border-black/[0.04] px-4 py-3 text-left transition-colors last:border-0 hover:bg-black/[0.03] dark:border-line dark:hover:bg-white/[0.04]"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-bold">{p.label}</span>
                          <span className="block text-[10px] text-zinc-500">{p.validity}</span>
                        </span>
                        <span className="font-display text-[13px] font-bold text-brand-deep dark:text-brand">
                          {money(p.price)}
                        </span>
                        {p.id === planId && <CheckCircle2 className="h-4 w-4 text-brand-deep dark:text-brand" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <PhoneInput value={phone} onChange={setPhone} />

          {/* Day picker */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <FieldLabel>Day of month</FieldLabel>
              <span className="rounded-lg bg-brand/15 px-2 py-1 font-display text-[11px] font-bold text-brand-deep dark:text-brand">
                Every {ordinal(day)}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={28}
              value={day}
              onChange={(e) => setDay(Number(e.target.value))}
              className="w-full accent-[#ffcb05]"
            />
            <div className="flex justify-between text-[9px] font-bold text-zinc-400">
              <span>1st</span>
              <span>14th</span>
              <span>28th</span>
            </div>
          </div>

          <button
            disabled={!ready}
            onClick={() => setPhase("confirm")}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 font-display text-[14px] font-bold transition-all",
              ready
                ? "bg-brand text-ink shadow-[0_10px_24px_rgba(255,203,5,0.3)] hover:-translate-y-0.5 active:scale-[0.98]"
                : "cursor-not-allowed bg-black/[0.05] text-zinc-400 dark:bg-white/[0.06] dark:text-zinc-500",
            )}
          >
            <CalendarClock className="h-4 w-4" strokeWidth={2.4} />
            Schedule top-up
          </button>
        </div>
      </div>

      <FlowSheet
        open={phase !== "idle"}
        phase={phase === "idle" ? "confirm" : phase}
        onClose={() => setPhase("idle")}
        title="Confirm auto top-up"
        rows={
          plan
            ? [
                { label: "Bundle", value: `${network} ${plan.label}` },
                { label: "Recipient", value: groupPhone(phone) },
                { label: "Repeats", value: `Every ${ordinal(day)} monthly` },
                { label: "Auto-charge", value: money(plan.price) },
              ]
            : []
        }
        ctaLabel="Activate schedule"
        onConfirm={submit}
        processingSteps={["Saving your schedule…", "Setting reminders…"]}
        result={result}
      />
    </div>
  );
}
