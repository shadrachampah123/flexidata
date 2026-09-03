"use client";

import { useEffect, useRef, useState } from "react";
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
import { DEPOSIT_MAX_GHS, DEPOSIT_MIN_GHS } from "@/lib/constants";
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
  fundingProvider = "paystack",
}: {
  wallet: WalletDTO;
  initialTab: "fund" | "transfer";
  pendingFundingRef?: string | null;
  /**
   * Which gateway the SERVER will use for deposits, resolved in
   * `src/app/wallet/page.tsx` via `paymentsProvider()`. It defaults to
   * `"paystack"` so this UI can never present a simulated instant top-up as a
   * real deposit unless the deployment explicitly opted into the mock provider.
   */
  fundingProvider?: "paystack" | "mock";
}) {
  const router = useRouter();
  const isPaystackFunding = fundingProvider === "paystack";
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
  // Which processing story the sheet tells:
  //   "init"   — we are asking the server to create the Paystack charge and
  //              hand back the checkout URL (browser is about to navigate away).
  //   "verify" — the customer already paid (or tried to) on Paystack and we are
  //              waiting for the SERVER to confirm it before saying anything
  //              about the wallet.
  const [stage, setStage] = useState<"init" | "verify">(pendingFundingRef ? "verify" : "init");
  const [result, setResult] = useState<FlowResult | null>(null);
  /** Bumped whenever a new fund/transfer flow starts (see the poll below). */
  const flowSeq = useRef(0);

  const fundAmount = fundChip ?? (Number(fundCustom.replace(/\D/g, "")) || 0);
  const trAmount = trChip ?? (Number(trCustom.replace(/\D/g, "")) || 0);
  const methodConf = METHODS.find((m) => m.id === method)!;
  const isCard = method === "card";

  // Same limits the server enforces in src/lib/deposits.ts (single source of
  // truth in src/lib/constants.ts) — the button only mirrors that validation.
  const fundReady =
    fundAmount >= DEPOSIT_MIN_GHS &&
    fundAmount <= DEPOSIT_MAX_GHS &&
    (isCard || isValidPhone(source));
  const insufficient = trAmount > balance;
  const transferReady = trAmount >= 1 && isValidPhone(dest) && !insufficient;

  // Returning from a Paystack redirect: open the processing sheet, nudge
  // settlement once (POST /api/payments/verify re-verifies with Paystack — the
  // redirect itself proves nothing), then poll the read-only, owner-checked
  // GET /api/wallet/deposit status endpoint. Settlement keeps being retried
  // periodically so the deposit clears even if the Paystack webhook is late.
  // If this tab is closed, the webhook still settles it server-side.
  useEffect(() => {
    if (!pendingFundingRef) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const MAX_ATTEMPTS = 12;
    // Captured once: if the customer starts a NEWER deposit/transfer from this
    // same page (the query param still carries the old reference), this poll
    // stops touching the UI instead of overwriting the new flow's sheet.
    const startedSeq = flowSeq.current;
    const stale = () => cancelled || flowSeq.current !== startedSeq;

    const finish = (result: FlowResult, refresh: boolean) => {
      if (stale()) return;
      setResult(result);
      setPhase("result");
      if (refresh) router.refresh();
    };

    // POST verify drives reconciliation (idempotent; safe to call repeatedly).
    const driveSettlement = async () => {
      try {
        await fetch("/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref: pendingFundingRef }),
        });
      } catch {
        // Network hiccup — the webhook + later retries still settle it.
      }
    };

    const leaveProcessing = (headline: string, message: string) => {
      finish(
        { status: "pending", ref: pendingFundingRef, headline, message, etaLabel: "Credits automatically" },
        true,
      );
    };

    const poll = async (attempt: number) => {
      if (stale()) return;
      // Settle immediately, then again every 3rd poll as a webhook fallback.
      if (attempt === 0 || attempt % 3 === 0) await driveSettlement();
      if (stale()) return;

      try {
        const res = await fetch(`/api/wallet/deposit?ref=${encodeURIComponent(pendingFundingRef)}`, {
          headers: { "Content-Type": "application/json" },
        });
        const data = (await res.json()) as {
          ok: boolean;
          deposit?: {
            status?: string;
            amount?: number;
            balance?: number;
            method?: string;
            provider?: string;
          };
        };
        if (stale()) return;
        const status = data.ok ? data.deposit?.status : undefined;

        if (status === "successful") {
          // Everything shown here comes from the SERVER's settled deposit row:
          // the credited amount and the new balance are read back from the
          // database, never taken from the form or assumed locally.
          const credited = typeof data.deposit?.amount === "number" ? data.deposit.amount : fundAmount;
          const provider = data.deposit?.provider;
          const providerLabel = provider === "mock" ? "Simulated (demo)" : "Paystack";
          finish(
            {
              status: "successful",
              ref: pendingFundingRef,
              headline: `+${money(credited)} added!`,
              message:
                provider === "mock"
                  ? "Demo deposit — no real payment was taken. Your money is safe and ready."
                  : "Funded via Paystack. Your money is safe and ready.",
              balance: data.deposit?.balance,
              lines: [
                { label: "Provider", value: providerLabel },
                ...(data.deposit?.method ? [{ label: "Method", value: data.deposit.method }] : []),
                { label: "Status", value: "Successful" },
                { label: "Fee", value: money(0) },
                { label: "Credited", value: money(credited) },
              ],
            },
            true,
          );
          return;
        }

        if (status === "failed" || status === "abandoned") {
          finish(
            {
              status: "failed",
              ref: pendingFundingRef,
              headline: status === "abandoned" ? "Checkout not completed" : "Payment not completed",
              message: "Payment was not completed. Your wallet has not been credited.",
            },
            false,
          );
          return;
        }

        if (attempt >= MAX_ATTEMPTS) {
          leaveProcessing(
            "Payment processing",
            "We're still confirming your payment with Paystack. Your wallet is credited automatically once it clears — usually within a minute. You can close this safely.",
          );
          return;
        }

        timer = setTimeout(() => poll(attempt + 1), 2500);
      } catch {
        if (stale()) return;
        if (attempt >= MAX_ATTEMPTS) {
          leaveProcessing(
            "Payment processing",
            "We lost the connection while confirming your payment. It will be credited automatically once Paystack confirms it — check your balance shortly.",
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
    // deposit and the status endpoint returns the credited amount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFundingRef, router]);

  const submit = async () => {
    flowSeq.current += 1;
    setStage("init");
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
        provider?: string;
        status?: string;
        authorizationUrl?: string;
      };
      if (res.status === 401 || data.code === "unauthenticated") {
        router.push("/login?next=/wallet");
        return;
      }
      // Real gateway (Paystack): the server created the charge and handed back
      // the hosted-checkout URL. Stay in the processing state ("Connecting to
      // Paystack…") while the browser navigates away — the wallet is NOT
      // credited here, and this screen never claims it was. Settlement happens
      // after Paystack redirects back (see the pendingFundingRef effect).
      if (tab === "fund" && data.status === "pending") {
        if (!data.authorizationUrl) {
          throw new Error("Could not open the Paystack checkout. Please try again.");
        }
        window.location.assign(data.authorizationUrl);
        return;
      }
      if (data.error === "insufficient_funds") {
        setResult({ status: "failed", headline: "Insufficient balance", message: "Top up your wallet and try again." });
        setPhase("result");
        return;
      }
      if (!data.ok) {
        throw new Error(
          data.code === "paystack_unconfigured"
            ? "Wallet funding is not available right now. Please try again later."
            : data.code === "paystack_init_failed"
              ? "Could not connect to Paystack. Please try again."
              : (data.error ?? "Failed"),
        );
      }
      if (typeof data.balance === "number") setBalance(data.balance);
      if (tab === "fund") {
        // Only reached when the server settled the deposit itself — i.e. the
        // opt-in mock provider (PAYMENTS_PROVIDER=mock), or a Paystack charge
        // the server had already verified. The balance shown is the one the
        // server returned, never a locally-computed one.
        const simulated = data.provider !== "paystack";
        const viaLabel = simulated ? (data.method ?? methodConf.label) : "Paystack";
        setResult({
          status: "successful",
          ref: data.ref,
          headline: `+${money(fundAmount)} added!`,
          message: simulated
            ? `Demo deposit via ${viaLabel} — no real payment was taken. Your money is safe and ready.`
            : "Funded via Paystack. Your money is safe and ready.",
          balance: data.balance,
          lines: [
            { label: "Provider", value: simulated ? "Simulated (demo)" : "Paystack" },
            { label: "Method", value: data.method ?? methodConf.label },
            { label: "Status", value: "Successful" },
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
            {isPaystackFunding && (
              <p className="mt-2 px-1 text-[10px] font-semibold text-zinc-400">
                You&apos;ll be redirected to Paystack&apos;s secure checkout to pay with mobile money
                or card. Your wallet is credited only after Paystack confirms the payment.
              </p>
            )}
          </div>

          {!isCard && (
            <div className="animate-fade-up" style={{ animationDelay: "120ms" }}>
              <PhoneInput
                value={source}
                onChange={setSource}
                label={isPaystackFunding ? `${methodConf.label} number` : `${methodConf.label} number to debit`}
              />
              {isPaystackFunding && (
                <p className="mt-1.5 px-1 text-[10px] font-semibold text-zinc-400">
                  Sent to Paystack as a hint — you confirm the number to debit on its secure page.
                </p>
              )}
            </div>
          )}

          <AmountBlock
            chips={FUND_CHIPS}
            chip={fundChip}
            setChip={setFundChip}
            custom={fundCustom}
            setCustom={setFundCustom}
            delay={isCard ? 120 : 180}
            note={`Deposit limit GH₵ ${DEPOSIT_MIN_GHS} – GH₵ ${DEPOSIT_MAX_GHS.toLocaleString()} per transaction.`}
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
                {
                  label: "Method",
                  value: isPaystackFunding ? `${methodConf.label} via Paystack` : methodConf.label,
                },
                ...(isCard
                  ? []
                  : [
                      {
                        label: isPaystackFunding ? "MoMo number" : "Debit from",
                        value: groupPhone(source),
                      },
                    ]),
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
        ctaLabel={
          tab === "fund" ? (isPaystackFunding ? "Continue to Paystack" : "Approve deposit") : "Send money"
        }
        onConfirm={submit}
        processingSteps={
          tab === "fund"
            ? isPaystackFunding
              ? stage === "verify"
                ? // Back from the Paystack checkout: nothing is claimed until
                  // the server has verified the charge.
                  ["Verifying payment…", "Confirming with Paystack…", "Crediting your wallet…"]
                : // Creating the charge server-side, then handing the browser
                  // to Paystack's hosted checkout.
                  ["Connecting to Paystack…", "Opening secure checkout…"]
              : isCard
                ? ["Contacting your bank…", "Verifying card…", "Crediting wallet…"]
                : [`Contacting ${methodConf.label}…`, "Approve the prompt on your phone…", "Crediting wallet…"]
            : ["Verifying recipient…", "Moving funds…", "Notifying recipient…"]
        }
        footnote={
          tab === "fund" && isPaystackFunding
            ? "Payments secured by Paystack • Your wallet is credited only after verification"
            : undefined
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
