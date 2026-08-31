"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HandCoins, Percent } from "lucide-react";
import type { WalletDTO } from "@/lib/data";
import type { Network } from "@/lib/constants";
import { NETWORKS, conversionFeeRate } from "@/lib/constants";
import { Segmented, FieldLabel } from "@/components/ui";
import { PhoneInput } from "@/components/phone-input";
import { FlowSheet, type FlowResult } from "@/components/flow-sheet";
import { cn, groupPhone, isValidPhone, money } from "@/lib/format";

const QUICK = [10, 20, 50, 100, 200];

export function Convert({ wallet }: { wallet: WalletDTO }) {
  const router = useRouter();
  const [network, setNetwork] = useState<Network>("MTN");
  const [chip, setChip] = useState<number | null>(50);
  const [custom, setCustom] = useState("");
  const [phone, setPhone] = useState("");
  const [balance, setBalance] = useState(wallet.balance);
  const [phase, setPhase] = useState<"idle" | "confirm" | "processing" | "result">("idle");
  const [result, setResult] = useState<FlowResult | null>(null);

  const amount = chip ?? (Number(custom.replace(/\D/g, "")) || 0);
  const feeRate = conversionFeeRate(amount);
  const fee = Math.round(amount * feeRate * 100) / 100;
  const payout = Math.round((amount - fee) * 100) / 100;
  const ready = amount >= 5 && amount <= 1000 && isValidPhone(phone);

  const submit = async () => {
    setPhase("processing");
    try {
      const res = await fetch("/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network, phone, amount }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        status?: string;
        ref?: string;
        payout?: number;
        fee?: number;
        feePct?: number;
        balance?: number;
      };
      if (!data.ok) throw new Error(data.error ?? "Failed");
      if (typeof data.balance === "number") setBalance(data.balance);
      const pending = data.status === "pending";
      setResult({
        status: pending ? "pending" : "successful",
        ref: data.ref,
        headline: pending ? "Confirming transfer" : `${money(data.payout ?? payout)} credited!`,
        message: pending
          ? "Once the network confirms the airtime transfer, cash lands in your wallet automatically."
          : "Cash has been added to your FlexiData wallet.",
        balance: data.balance,
        lines: [
          { label: "Airtime converted", value: money(amount) },
          { label: "Processing fee", value: `- ${money(data.fee ?? fee)} (${data.feePct ?? Math.round(feeRate * 100)}%)` },
          { label: "You received", value: money(data.payout ?? payout) },
        ],
      });
      setPhase("result");
      router.refresh();
    } catch (e) {
      setResult({
        status: "failed",
        headline: "Conversion failed",
        message: e instanceof Error ? e.message : "Something went wrong. Try again.",
      });
      setPhase("result");
    }
  };

  return (
    <div className="space-y-5">
      <div className="animate-fade-up">
        <FieldLabel>Network</FieldLabel>
        <Segmented
          options={NETWORKS.map((n) => ({ id: n.id, label: n.label, dot: n.dot }))}
          value={network}
          onChange={(id) => setNetwork(id as Network)}
        />
      </div>

      <div className="animate-fade-up" style={{ animationDelay: "60ms" }}>
        <PhoneInput value={phone} onChange={setPhone} label="Number holding the airtime" />
      </div>

      <div className="animate-fade-up" style={{ animationDelay: "120ms" }}>
        <FieldLabel>Airtime amount</FieldLabel>
        <div className="grid grid-cols-5 gap-2">
          {QUICK.map((v) => (
            <button
              key={v}
              onClick={() => {
                setChip(v);
                setCustom("");
              }}
              className={cn(
                "rounded-xl border py-2.5 font-display text-[13px] font-bold transition-all active:scale-95",
                chip === v
                  ? "border-brand bg-brand text-ink"
                  : "border-black/[0.06] bg-paper hover:border-brand/40 dark:border-line dark:bg-card",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex items-center gap-2 rounded-2xl border border-black/[0.08] bg-paper px-4 py-[13px] transition-all focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/30 dark:border-line dark:bg-card">
          <span className="font-display text-[15px] font-bold text-zinc-400">GH₵</span>
          <input
            inputMode="numeric"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value.replace(/\D/g, "").slice(0, 4));
              setChip(null);
            }}
            placeholder="Enter amount (5 – 1,000)"
            className="w-full min-w-0 flex-1 bg-transparent font-display text-[15px] font-bold outline-none placeholder:font-sans placeholder:text-xs placeholder:font-semibold placeholder:text-zinc-400"
          />
        </div>
      </div>

      {/* Live breakdown */}
      <div className="animate-fade-up" style={{ animationDelay: "180ms" }}>
        <div className="overflow-hidden rounded-[1.6rem] border border-black/[0.05] bg-paper shadow-sm dark:border-line dark:bg-card">
          <div className="flex items-center justify-between border-b border-black/[0.05] px-5 py-3 dark:border-line">
            <span className="flex items-center gap-2 text-xs font-bold text-zinc-500 dark:text-zinc-400">
              <HandCoins className="h-4 w-4 text-brand-deep dark:text-brand" />
              Payout breakdown
            </span>
            <span className="flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-[9px] font-black text-brand-deep dark:text-brand">
              <Percent className="h-3 w-3" /> {Math.round(feeRate * 100)}% FEE
            </span>
          </div>
          <div className="space-y-2.5 px-5 py-4 text-[13px] font-semibold">
            <div className="flex justify-between">
              <span className="text-zinc-500 dark:text-zinc-400">Airtime value</span>
              <span className="font-display font-bold">{money(amount)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500 dark:text-zinc-400">Processing fee</span>
              <span className="font-display font-bold text-rose-500">− {money(fee)}</span>
            </div>
            <div className="border-t border-dashed border-black/10 pt-2.5 dark:border-line" />
            <div className="flex items-center justify-between">
              <span className="font-bold">You receive</span>
              <span className="font-display text-xl font-bold text-emerald-500">{money(payout)}</span>
            </div>
          </div>
          <p className="bg-emerald-500/[0.07] px-5 py-2.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
            Credited directly to your FlexiData wallet • New balance ≈ {money(balance + payout)}
          </p>
        </div>
        <p className="mt-2 px-1 text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          Fee is 12% for amounts under GH₵ 200, and 10% for GH₵ 200 and above. Rates include network
          charges.
        </p>
      </div>

      <button
        disabled={!ready}
        onClick={() => setPhase("confirm")}
        className={cn(
          "animate-fade-up flex w-full items-center justify-center gap-2 rounded-2xl py-4 font-display text-[15px] font-bold transition-all",
          ready
            ? "bg-brand text-ink shadow-[0_12px_28px_rgba(255,203,5,0.35)] hover:-translate-y-0.5 active:scale-[0.98]"
            : "cursor-not-allowed bg-black/[0.05] text-zinc-400 dark:bg-white/[0.06] dark:text-zinc-500",
        )}
        style={{ animationDelay: "240ms" }}
      >
        Convert now{ready ? ` — ${money(payout)}` : ""}
      </button>

      <FlowSheet
        open={phase !== "idle"}
        phase={phase === "idle" ? "confirm" : phase}
        onClose={() => setPhase("idle")}
        title="Confirm conversion"
        rows={[
          { label: "Network", value: network },
          { label: "From number", value: groupPhone(phone) },
          { label: "Airtime value", value: money(amount) },
          { label: "Processing fee", value: `- ${money(fee)} (${Math.round(feeRate * 100)}%)` },
        ]}
        total={{ label: "You receive", value: money(payout) }}
        ctaLabel={`Convert ${money(amount)} airtime`}
        onConfirm={submit}
        processingSteps={[
          "Sending transfer prompt…",
          `Confirm ${money(amount)} airtime moved from ${groupPhone(phone)}`,
          "Crediting your wallet…",
        ]}
        result={result}
      />
    </div>
  );
}
