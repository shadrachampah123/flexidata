"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BadgePercent, TriangleAlert } from "lucide-react";
import type { WalletDTO } from "@/lib/data";
import type { Network } from "@/lib/constants";
import { NETWORKS, AIRTIME_DISCOUNT } from "@/lib/constants";
import { Segmented, FieldLabel } from "@/components/ui";
import { PhoneInput } from "@/components/phone-input";
import { FlowSheet, type FlowResult } from "@/components/flow-sheet";
import { cn, groupPhone, isValidPhone, money } from "@/lib/format";

const QUICK = [2, 5, 10, 20, 50, 100];

export function BuyAirtime({ wallet }: { wallet: WalletDTO }) {
  const router = useRouter();
  const [network, setNetwork] = useState<Network>("MTN");
  const [amount, setAmount] = useState<number | null>(10);
  const [custom, setCustom] = useState("");
  const [phone, setPhone] = useState("");
  const [balance, setBalance] = useState(wallet.balance);
  const [phase, setPhase] = useState<"idle" | "confirm" | "processing" | "result">("idle");
  const [result, setResult] = useState<FlowResult | null>(null);

  const face = amount ?? (Number(custom.replace(/\D/g, "")) || 0);
  const cost = Math.round(face * (1 - AIRTIME_DISCOUNT) * 100) / 100;
  const saved = Math.round(face * AIRTIME_DISCOUNT * 100) / 100;
  const insufficient = face > 0 && balance < cost;
  const ready = face >= 1 && face <= 500 && isValidPhone(phone) && !insufficient;

  const pickChip = (v: number) => {
    setAmount(v);
    setCustom("");
  };

  const submit = async () => {
    setPhase("processing");
    try {
      const res = await fetch("/api/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "airtime", network, amount: face, recipient: phone }),
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
        setResult({ status: "failed", headline: "Insufficient balance", message: "Top up your wallet and try again." });
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
            ? "Airtime sent!"
            : data.status === "pending"
              ? "Top-up processing"
              : "Purchase failed",
        pointsEarned: data.pointsEarned,
        balance: data.balance,
        lines: [
          { label: "Airtime", value: `${network} GH₵ ${face.toFixed(0)}` },
          { label: "Recipient", value: groupPhone(phone) },
          { label: "Discount", value: `- ${money(saved)}` },
          { label: "You paid", value: money(cost) },
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
      <div className="animate-fade-up">
        <FieldLabel>Network</FieldLabel>
        <Segmented
          options={NETWORKS.map((n) => ({ id: n.id, label: n.label, dot: n.dot }))}
          value={network}
          onChange={(id) => setNetwork(id as Network)}
        />
      </div>

      <div className="animate-fade-up" style={{ animationDelay: "60ms" }}>
        <div className="mb-2 flex items-center justify-between">
          <FieldLabel>Amount</FieldLabel>
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-black text-emerald-600 dark:text-emerald-400">
            <BadgePercent className="h-3 w-3" /> 2% OFF APPLIED
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          {QUICK.map((v) => (
            <button
              key={v}
              onClick={() => pickChip(v)}
              className={cn(
                "rounded-2xl border py-3.5 font-display text-[15px] font-bold transition-all active:scale-95",
                amount === v
                  ? "border-brand bg-brand text-ink shadow-[0_8px_18px_rgba(255,203,5,0.3)]"
                  : "border-black/[0.06] bg-paper hover:border-brand/40 dark:border-line dark:bg-card",
              )}
            >
              GH₵ {v}
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex items-center gap-2 rounded-2xl border border-black/[0.08] bg-paper px-4 py-[13px] transition-all focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/30 dark:border-line dark:bg-card">
          <span className="font-display text-[15px] font-bold text-zinc-400">GH₵</span>
          <input
            inputMode="numeric"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value.replace(/\D/g, "").slice(0, 3));
              setAmount(null);
            }}
            placeholder="Custom amount (1 – 500)"
            className="w-full min-w-0 flex-1 bg-transparent font-display text-[15px] font-bold outline-none placeholder:font-sans placeholder:text-xs placeholder:font-semibold placeholder:text-zinc-400"
          />
        </div>
        {face > 0 && (
          <div className="animate-fade-up mt-3 flex items-center justify-between rounded-2xl bg-brand/[0.08] px-4 py-2.5 text-xs font-bold">
            <span className="text-zinc-500 dark:text-zinc-400">
              {money(face)} airtime for{" "}
              <span className="text-brand-deep dark:text-brand">{money(cost)}</span>
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">save {money(saved)}</span>
          </div>
        )}
      </div>

      <div className="animate-fade-up" style={{ animationDelay: "120ms" }}>
        <PhoneInput value={phone} onChange={setPhone} />
      </div>

      <div className="animate-fade-up sticky bottom-[78px] z-30 md:bottom-4" style={{ animationDelay: "180ms" }}>
        <div className="flex items-center gap-3 rounded-[1.4rem] border border-black/[0.06] bg-[#14161c] p-3 pl-4 text-white shadow-[0_16px_40px_rgba(0,0,0,0.35)] dark:border-line">
          <div className="min-w-0 flex-1">
            <p className="font-display text-[14px] font-bold">
              {face > 0 ? `${network} GH₵ ${face.toFixed(0)} • ${money(cost)}` : "Enter an amount"}
            </p>
            <p className={cn("text-[10px] font-semibold", insufficient ? "text-amber-400" : "text-white/50")}>
              Balance {money(balance)} {insufficient && "• insufficient"}
            </p>
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
              Top up
            </button>
          )}
        </div>
      </div>

      <FlowSheet
        open={phase !== "idle"}
        phase={phase === "idle" ? "confirm" : phase}
        onClose={() => setPhase("idle")}
        title="Confirm top-up"
        rows={[
          { label: "Network", value: network },
          { label: "Airtime", value: `GH₵ ${face.toFixed(0)}` },
          { label: "Recipient", value: groupPhone(phone) },
          { label: "Discount", value: `- ${money(saved)} (2%)` },
        ]}
        total={{ label: "You pay", value: money(cost) }}
        ctaLabel={`Pay ${money(cost)}`}
        onConfirm={submit}
        processingSteps={[`Contacting ${network}…`, "Authorising top-up…", "Crediting recipient…"]}
        result={result}
      />
    </div>
  );
}
