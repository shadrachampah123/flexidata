"use client";

import { useState } from "react";
import { Loader2, Radar, TriangleAlert } from "lucide-react";
import { Badge, Note, Panel, StatusPill } from "@/components/admin/ui";
import { adminMoney, formatDateTime } from "@/lib/admin/format";
import type {
  AdminPaystackProbeRefusal,
  AdminPaystackProbeResult,
} from "@/lib/admin/types";

/**
 * Phase 2, Step 3 (S3.6) — the read-only Paystack status probe.
 *
 * This is the ONLY interactive element on an investigation page, and it is
 * deliberately not a write surface:
 *
 *  - it issues a **GET** and nothing else. There is no POST, PUT, PATCH or
 *    DELETE anywhere in this file, so the admin browser write surface remains
 *    exactly the two confirmation modals the Phase 1/2 harnesses allowlist
 *    (`customer-actions.tsx`, `order-support-actions.tsx`).
 *  - the endpoint it calls asks Paystack what it holds for the reference and
 *    compares that with our stored values. It settles nothing, credits nothing,
 *    refunds nothing, retries nothing and writes no row — not even an audit row.
 *  - the result is transient by design: it is rendered, never persisted. If an
 *    operator needs the finding on the record, they use the audited Step 2
 *    support action (refund review) from Requires support.
 *
 * The button restates what it is about to do, shows the gateway mode (`test` /
 * `live` — never a key), and every successful response carries the same notice:
 * "Diagnostic only — nothing was written, settled, credited, refunded or
 * retried."
 */

type ProbeState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "result"; result: AdminPaystackProbeResult }
  | { kind: "refusal"; refusal: AdminPaystackProbeRefusal }
  | { kind: "error"; message: string };

const REFUSAL_STATUS: Record<AdminPaystackProbeRefusal["error"], string> = {
  "not-found": "That reference does not exist in this database.",
  unavailable: "Paystack verification is not available on this deployment.",
  throttled: "Too many checks — the probe is rate-limited per administrator.",
  upstream: "Paystack could not answer for this reference.",
  timeout: "Paystack did not answer in time.",
};

export function PaystackStatusProbe({
  endpoint,
  available,
  mode,
  reason,
  subjectLabel,
}: {
  /** `/api/admin/orders/<ref>/paystack-status` or the payments equivalent. */
  endpoint: string;
  available: boolean;
  mode: "test" | "live" | "unconfigured";
  reason: string | null;
  /** e.g. "order CO-XXXX" — restated in the button so the target is explicit. */
  subjectLabel: string;
}) {
  const [state, setState] = useState<ProbeState>({ kind: "idle" });

  const runProbe = async () => {
    setState({ kind: "loading" });
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | AdminPaystackProbeResult
        | AdminPaystackProbeRefusal
        | { error?: string }
        | null;

      if (response.status === 404) {
        setState({
          kind: "error",
          message: "This check is no longer available — your admin session may have ended.",
        });
        return;
      }
      if (payload && "ok" in payload && payload.ok === true) {
        setState({ kind: "result", result: payload });
        return;
      }
      if (payload && "ok" in payload && payload.ok === false) {
        setState({ kind: "refusal", refusal: payload });
        return;
      }
      setState({ kind: "error", message: "The check could not be completed. Try again shortly." });
    } catch {
      setState({ kind: "error", message: "The request failed. Nothing was changed." });
    }
  };

  return (
    <Panel
      title="Paystack status check"
      subtitle="Read-only: asks the gateway what it holds for this reference and compares it with our stored values."
      actions={
        <Badge tone={mode === "live" ? "brand" : "neutral"}>
          {mode === "unconfigured" ? "gateway not configured" : `${mode} mode`}
        </Badge>
      }
      bodyClassName="px-4 py-3"
    >
      {!available ? (
        <Note>{reason ?? "Paystack is not configured on this server."}</Note>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void runProbe()}
              disabled={state.kind === "loading"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-black/[0.08] bg-white px-2.5 py-1.5 text-[12px] font-semibold transition-colors hover:border-brand disabled:opacity-50 dark:border-line dark:bg-card2"
            >
              {state.kind === "loading" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Radar className="h-3.5 w-3.5" />
              )}
              {state.kind === "loading" ? "Asking Paystack…" : `Ask Paystack about ${subjectLabel}`}
            </button>
            <Note>
              Nothing is written, settled, credited or refunded by this check — it only reads what the
              gateway already recorded.
            </Note>
          </div>

          {state.kind === "error" && (
            <p className="flex items-start gap-1.5 text-[12px] text-rose-600 dark:text-rose-400">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {state.message}
            </p>
          )}

          {state.kind === "refusal" && (
            <div className="space-y-1 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2">
              <p className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">
                {REFUSAL_STATUS[state.refusal.error] ?? "The check could not be completed."}
              </p>
              <p className="text-[11px] leading-relaxed opacity-70">{state.refusal.message}</p>
            </div>
          )}

          {state.kind === "result" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill severity={state.result.verdict.severity}>
                  {state.result.verdict.label}
                </StatusPill>
                <Badge tone="mono">
                  {state.result.mode} · {formatDateTime(state.result.probedAt)} ·{" "}
                  {state.result.elapsedMs}ms
                </Badge>
              </div>

              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {[
                  { label: "Gateway status", value: state.result.verification.rawStatus },
                  { label: "Reference", value: state.result.verification.reference ?? "—" },
                  {
                    label: "Amount (pesewas)",
                    value:
                      state.result.verification.amountSubunits === null
                        ? "—"
                        : `${state.result.verification.amountSubunits} (${adminMoney(
                            state.result.verification.amountSubunits / 100,
                          )})`,
                  },
                  { label: "Currency", value: state.result.verification.currency ?? "—" },
                  {
                    label: "Transaction id",
                    value: state.result.verification.transactionId ?? "—",
                  },
                  { label: "Channel", value: state.result.verification.channel ?? "—" },
                  {
                    label: "Paid at",
                    value: formatDateTime(state.result.verification.paidAt),
                  },
                  {
                    label: "Gateway response",
                    value: state.result.verification.gatewayResponse ?? "—",
                  },
                ].map((item) => (
                  <div key={item.label} className="min-w-0">
                    <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
                      {item.label}
                    </dt>
                    <dd className="mt-0.5 break-words text-[12px]">{item.value}</dd>
                  </div>
                ))}
              </dl>

              <p className="text-[12px] leading-relaxed opacity-70">
                {state.result.verdict.detail}
              </p>

              {state.result.findings.length > 0 && (
                <ul className="space-y-1.5">
                  {state.result.findings.map((finding) => (
                    <li key={finding.id} className="text-[11px] leading-relaxed opacity-70">
                      <span className="font-semibold">{finding.label}.</span> {finding.guidance}
                    </li>
                  ))}
                </ul>
              )}

              <Note className="border-t border-black/[0.05] pt-2 dark:border-line">
                {state.result.notice} The result is shown here only — it is not stored, and it does
                not change any record.
              </Note>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
