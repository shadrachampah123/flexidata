"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CreditCard,
  Phone,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { WalletDTO } from "@/lib/data";
import { Segmented, FieldLabel } from "@/components/ui";
import { PhoneInput } from "@/components/phone-input";
import { FlowSheet, type FlowResult } from "@/components/flow-sheet";
import { cn, groupPhone, isValidPhone, money } from "@/lib/format";

type Method = { id: string; label: string; sub: string; dot: string; icon: LucideIcon };

const METHODS: Method[] = [
  { id: "momo_mtn", label: "MTN MoMo", sub: "Instant approval • No fee", dot: "#FFCB05", icon: Smartphone },
  { id: "telecel_cash", label: "Telecel Cash", sub: "Instant approval • No fee", dot: "#F04438", icon: Phone },
  { id: "card", label: "Debit card", sub: "Visa •• 4432 • No fee", dot: "#38BDF8", icon: CreditCard },
];

const FUND_CHIPS = [20, 50, 100, 200, 500];
const TRANSFER_CHIPS = [10, 20, 50, 100];

export function WalletTools({
  wallet,
  initialTab,
  pendingFundingRef,
}: {
  wallet: WalletDTO;
  initialTab: "fund" | "transfer";
  pendingFundingRef?: string | null;
}) {
  const router = useRouter();
  // When we land here straight back from a Paystack redirect the sheet opens
  // straight into its processing/polling state.
  const [tab, setTab] = useState<"fund" | "transfer">(pendingFundingRef ? "fund" : initialTab);
  const [method, setMethod] = useState("momo_mtn");
  const [balance, setBalance] = useState(wallet.balance);

  const [fundChip, setFundChip] = useState<number | null>(50);
  const [fundCustom, setFundCustom] = useState("");
  const [source, setSource] = useState(wallet.number);

  const [trChip, setTrChip] = useState<number | null>(20);
  const [trCustom, setTrCustom] = useState("");
  const [dest, setDest] = useState("");

  const [phase, setPhase] = useState<"idle" | "confirm" | "processing" | "result">(
    pendingFundingRef ? "processing" : "idle",
  );
  const [result, setResult] = useState<FlowResult | null>(null);

  const fundAmount = fundChip ?? (Number(fundCustom.replace(/\D/g, "")) || 0);
  const trAmount = trChip ?? (Number(trCustom.replace(/\D/g, "")) || 0);
  const methodConf = METHODS.find((m) => m.id === method)!;
  const isCard = method === "card";

  const fundReady = fundAmount >= 5 && fundAmount <= 5000 && (isCard || isValidPhone(source));
  const insufficient = trAmount > balance;
  const transferReady = trAmount >= 1 && isValidPhone(dest) && !insufficient;

  // Returning from a Paystack redirect: open the processing sheet and poll
  // /api/payments/verify until the deposit settles (the server re-verifies
  // with Paystack, so the redirect itself proves nothing). Even if this tab
  // is closed, the Paystack webhook settles it server-side.
  useEffect(() => {
    if (!pendingFundingRef) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: FlowResult, refresh: boolean) => {
      if (cancelled) return;
      setResult(result);
      setPhase("result");
      if (refresh) router.refresh();
    };

    const poll = async (attempt: number) => {
      if (cancelled) return;
      try {
        const res = await fetch("/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref: pendingFundingRef }),
        });
        const data = (await res.json()) as {
          ok: boolean;
          status?: string;
          balance?: number;
          amount?: number;
        };

        if (cancelled) return;

        if (data.ok && data.status === "successful") {
          const credited = typeof data.amount === "number" ? data.amount : fundAmount;
          finish(
            {
              status: "successful",
              ref: pendingFundingRef,
              headline: `+${money(credited)} added!`,
              message: "Payment confirmed by Paystack. Your wallet has been credited and is ready to spend.",
              balance: data.balance,
              lines: [
                { label: "Status", value: "Confirmed" },
                { label: "Fee", value: money(0) },
                { label: "Credited", value: money(credited) },
              ],
            },
            true,
          );
          return;
        }

        if (data.ok && (data.status === "failed" || data.status === "abandoned")) {
          finish(
            {
              status: "failed",
              ref: pendingFundingRef,
              headline: "Deposit not completed",
              message:
                "We could not confirm a successful payment, so your wallet was not credited. You have not been charged for a failed payment — try again.",
            },
            false,
          );
          return;
        }

        // Still pending at Paystack. Keep polling for a while, then leave the
        // deposit in a visible "processing" state — the webhook will settle it.
        if (attempt >= 12) {
          finish(
            {
              status: "pending",
              ref: pendingFundingRef,
              headline: "Payment processing",
              message:
                "We're still confirming your payment with Paystack. Your wallet is credited automatically once it clears — usually within a minute. You can close this safely.",
              etaLabel: "Credits automatically",
            },
            true,
          );
          return;
        }

        timer = setTimeout(() => poll(attempt + 1), 2500);
      } catch {
        if (cancelled) return;
        if (attempt >= 12) {
          finish(
            {
              status: "pending",
              ref: pendingFundingRef,
              headline: "Payment processing",
              message:
                "We lost the connection while confirming your payment. It will be credited automatically once Paystack confirms it — check your balance shortly.",
              etaLabel: "Credits automatically",
            },
            true,
          );
          return;
        }
        timer = setTimeout(() => poll(attempt + 1), 2500);
      }
    };

    poll(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // fundAmount is intentionally not a dependency: the ref identifies the
    // deposit and the server returns the credited amount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFundingRef, router]);

  const submit = async () => {
    setPhase("processing");
    try {
      const res = await fetch(tab === "fund" ? "/api/wallet/fund" : "/api/wallet/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          tab === "fund"
            ? { method, amount: fundAmount, source: isCard ? undefined : groupPhone(source) }
            : { account: dest, amount: trAmount },
        ),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        code?: string;
        ref?: string;
        balance?: number;
        method?: string;
        status?: string;
        authorizationUrl?: string;
      };
      if (res.status === 401 || data.code === "unauthenticated") {
        router.push("/login?next=/wallet");
        return;
      }
      // Real gateway (Paystack): redirect to the hosted checkout.
      if (data.status === "pending" && data.authorizationUrl) {
        window.location.href = data.authorizationUrl;
        return;
      }
      if (data.error === "insufficient_funds") {
        setResult({ status: "failed", headline: "Insufficient balance", message: "Top up your wallet and try again." });
        setPhase("result");
        return;
      }
      if (!data.ok) throw new Error(data.error ?? "Failed");
      if (typeof data.balance === "number") setBalance(data.balance);
      if (tab === "fund") {
        setResult({
          status: "successful",
          ref: data.ref,
          headline: `+${money(fundAmount)} added!`,
          message: `Funded via ${data.method ?? methodConf.label}. Your money is safe and ready to spend.`,
          balance: data.balance,
          lines: [
            { label: "Method", value: data.method ?? methodConf.label },
            { label: "Fee", value: money(0) },
            { label: "Credited", value: money(fundAmount) },
          ],
        });
      } else {
        setResult({
          status: "successful",
          ref: data.ref,
          headline: `${money(trAmount)} sent!`,
          message: "The recipient has been notified. Transfers on FlexiData are always free.",
          balance: data.balance,
          lines: [
            { label: "Recipient wallet", value: groupPhone(dest) },
            { label: "Amount", value: money(trAmount) },
            { label: "Fee", value: money(0) },
          ],
        });
      }
      setPhase("result");
      router.refresh();
    } catch (e) {
      setResult({
        status: "failed",
        headline: tab === "fund" ? "Deposit failed" : "Transfer failed",
        message: e instanceof Error ? e.message : "Something went wrong. Try again.",
      });
      setPhase("result");
    }
  };

  const amount = tab === "fund" ? fundAmount : trAmount;
  const ready = tab === "fund" ? fundReady : transferReady;

  return (
    <div className="space-y-5">
      <div className="animate-fade-up">
        <Segmented
          options={[
            { id: "fund", label: "Fund wallet" },
            { id: "transfer", label: "Transfer" },
          ]}
          value={tab}
          onChange={(id) => setTab(id as "fund" | "transfer")}
        />
      </div>

      {tab === "fund" ? (
        <>
          <div className="animate-fade-up" style={{ animationDelay: "60ms" }}>
            <FieldLabel>Payment method</FieldLabel>
            <div className="space-y-2">
              {METHODS.map((m) => {
                const active = method === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setMethod(m.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-2xl border bg-paper px-4 py-3.5 text-left transition-all active:scale-[0.99] dark:bg-card",
                      active
                        ? "border-brand ring-2 ring-brand/30"
                        : "border-black/[0.06] hover:border-brand/40 dark:border-line",
                    )}
                  >
                    <span
                      className="flex h-10 w-10 items-center justify-center rounded-xl"
                      style={{ backgroundColor: `${m.dot}22`, color: m.dot === "#FFCB05" ? "#c79e00" : m.dot }}
                    >
                      <m.icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-bold">{m.label}</span>
                      <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{m.sub}</span>
                    </span>
                    <span
                      className={cn(
                        "h-4 w-4 rounded-full border-[5px] transition-all",
                        active ? "border-brand" : "border-zinc-300 dark:border-zinc-600",
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {!isCard && (
            <div className="animate-fade-up" style={{ animationDelay: "120ms" }}>
              <PhoneInput
                value={source}
                onChange={setSource}
                label={`${methodConf.label} number to debit`}
              />
            </div>
          )}

          <AmountBlock
            chips={FUND_CHIPS}
            chip={fundChip}
            setChip={setFundChip}
            custom={fundCustom}
            setCustom={setFundCustom}
            delay={isCard ? 120 : 180}
            note="Deposit limit GH₵ 5 – GH₵ 5,000 per transaction."
          />
        </>
      ) : (
        <>
          <div className="animate-fade-up" style={{ animationDelay: "60ms" }}>
            <PhoneInput value={dest} onChange={setDest} label="Recipient wallet number" />
          </div>
          <AmountBlock
            chips={TRANSFER_CHIPS}
            chip={trChip}
            setChip={setTrChip}
            custom={trCustom}
            setCustom={setTrCustom}
            delay={120}
            note="Transfers between FlexiData wallets are always free and instant."
          />
          {insufficient && (
            <Link
              href="/wallet"
              onClick={(e) => {
                e.preventDefault();
                setTab("fund");
              }}
              className="flex items-center gap-2 rounded-2xl bg-amber-400/15 px-4 py-3 text-xs font-bold text-amber-600 transition-all active:scale-[0.98] dark:text-amber-400"
            >
              <TriangleAlert className="h-4 w-4 shrink-0" />
              Insufficient balance — tap to fund your wallet first
            </Link>
          )}
        </>
      )}

      <button
        disabled={!ready}
        onClick={() => setPhase("confirm")}
        className={cn(
          "animate-fade-up flex w-full items-center justify-center gap-2 rounded-2xl py-4 font-display text-[15px] font-bold transition-all",
          ready
            ? "bg-brand text-ink shadow-[0_12px_28px_rgba(255,203,5,0.35)] hover:-translate-y-0.5 active:scale-[0.98]"
            : "cursor-not-allowed bg-black/[0.05] text-zinc-400 dark:bg-white/[0.06] dark:text-zinc-500",
        )}
        style={{ animationDelay: "220ms" }}
      >
        <ShieldCheck className="h-5 w-5" strokeWidth={2.2} />
        {tab === "fund"
          ? `Deposit ${fundAmount > 0 ? money(fundAmount) : ""}`
          : `Send ${trAmount > 0 ? money(trAmount) : ""}`}
      </button>

      <FlowSheet
        open={phase !== "idle"}
        phase={phase === "idle" ? "confirm" : phase}
        onClose={() => setPhase("idle")}
        title={tab === "fund" ? "Confirm deposit" : "Confirm transfer"}
        rows={
          tab === "fund"
            ? [
                { label: "Method", value: methodConf.label },
                ...(isCard ? [] : [{ label: "Debit from", value: groupPhone(source) }]),
                { label: "Fee", value: money(0) },
              ]
            : [
                { label: "Recipient wallet", value: groupPhone(dest) },
                { label: "Fee", value: money(0) },
              ]
        }
        total={
          tab === "fund"
            ? { label: "Top-up", value: money(fundAmount) }
            : { label: "You send", value: money(trAmount) }
        }
        ctaLabel={tab === "fund" ? "Approve deposit" : "Send money"}
        onConfirm={submit}
        processingSteps={
          tab === "fund"
            ? isCard
              ? ["Contacting your bank…", "Verifying card…", "Crediting wallet…"]
              : [`Contacting ${methodConf.label}…`, "Approve the prompt on your phone…", "Crediting wallet…"]
            : ["Verifying recipient…", "Moving funds…", "Notifying recipient…"]
        }
        result={result}
      />
    </div>
  );
}

function AmountBlock({
  chips,
  chip,
  setChip,
  custom,
  setCustom,
  delay,
  note,
}: {
  chips: number[];
  chip: number | null;
  setChip: (v: number | null) => void;
  custom: string;
  setCustom: (v: string) => void;
  delay: number;
  note: string;
}) {
  return (
    <div className="animate-fade-up" style={{ animationDelay: `${delay}ms` }}>
      <FieldLabel>Amount</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {chips.map((v) => (
          <button
            key={v}
            onClick={() => {
              setChip(v);
              setCustom("");
            }}
            className={cn(
              "rounded-xl border px-4 py-2.5 font-display text-[13px] font-bold transition-all active:scale-95",
              chip === v
                ? "border-brand bg-brand text-ink"
                : "border-black/[0.06] bg-paper hover:border-brand/40 dark:border-line dark:bg-card",
            )}
          >
            {money(v)}
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
          placeholder="Custom amount"
          className="w-full min-w-0 flex-1 bg-transparent font-display text-[15px] font-bold outline-none placeholder:font-sans placeholder:text-xs placeholder:font-semibold placeholder:text-zinc-400"
        />
      </div>
      <p className="mt-2 px-1 text-[10px] font-semibold text-zinc-400">{note}</p>
    </div>
  );
}
