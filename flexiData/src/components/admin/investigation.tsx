import Link from "next/link";
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, ScrollText } from "lucide-react";
import { Badge, KeyValues, Note, Panel, StatusPill } from "@/components/admin/ui";
import { adminMoney, formatDateTime } from "@/lib/admin/format";
import type { DiagnosisFinding, DiagnosisVerdict } from "@/lib/admin/diagnosis";
import type { AdminRecordedAction } from "@/lib/admin/types";
import { AUDIT_ACTION_LABELS } from "@/lib/admin/queries-investigation";

/**
 * Phase 2, Step 3 — presentational panels for the investigation pages.
 *
 * These are plain Server Components: no `"use client"`, no hooks, no data
 * access and — importantly — **no controls**. They render facts and the pure
 * diagnosis derived from them. There is deliberately no button anywhere in this
 * file that could change a record: the only interactive element on an
 * investigation page is the read-only Paystack status probe in
 * `./paystack-probe.tsx`, which issues a GET and writes nothing.
 *
 * The one place an operator can still ACT on an order remains the Step 2 support
 * workflow on `/admin/attention`; these panels link to it rather than
 * duplicating it, so there is exactly one audited write path.
 */

const FINDING_ICONS = {
  critical: CircleAlert,
  attention: Info,
  healthy: CircleCheck,
  unknown: Info,
} as const;

/** The banner: the single most severe finding, plus the count of the rest. */
export function VerdictBanner({
  verdict,
  findings,
  footer,
}: {
  verdict: DiagnosisVerdict;
  findings: DiagnosisFinding[];
  footer?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill severity={verdict.severity}>{verdict.label}</StatusPill>
        {findings.length > 1 && (
          <span className="text-[11px] opacity-55">
            + {findings.length - 1} other finding{findings.length === 2 ? "" : "s"}
          </span>
        )}
      </div>
      <p className="max-w-3xl text-[12px] leading-relaxed opacity-70">{verdict.detail}</p>
      {footer}
    </div>
  );
}

/** Every finding, most severe first, each with what an operator may do. */
export function FindingsPanel({ findings }: { findings: DiagnosisFinding[] }) {
  return (
    <Panel
      title="Diagnosis"
      subtitle="Derived from the stored record by a pure classifier. Nothing here was written, settled or corrected."
      bodyClassName="px-4 py-3"
    >
      {findings.length === 0 ? (
        <Note>No findings.</Note>
      ) : (
        <ul className="space-y-3">
          {findings.map((finding) => {
            const Icon = FINDING_ICONS[finding.severity] ?? Info;
            return (
              <li key={finding.id} className="flex gap-2.5">
                <span className="mt-0.5 shrink-0">
                  <Icon
                    className={
                      finding.severity === "critical"
                        ? "h-4 w-4 text-rose-600 dark:text-rose-400"
                        : finding.severity === "attention"
                          ? "h-4 w-4 text-amber-600 dark:text-amber-400"
                          : finding.severity === "healthy"
                            ? "h-4 w-4 text-emerald-600 dark:text-emerald-400"
                            : "h-4 w-4 opacity-50"
                    }
                    strokeWidth={2.2}
                  />
                </span>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13px] font-semibold">{finding.label}</p>
                    <Badge tone="mono">{finding.id}</Badge>
                  </div>
                  <p className="text-[12px] leading-relaxed opacity-70">{finding.detail}</p>
                  <p className="text-[11px] leading-relaxed opacity-55">{finding.guidance}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Note className="mt-3 border-t border-black/[0.05] pt-2 dark:border-line">
        This dashboard has no refund, reversal, balance correction or delivery retry. Findings are
        for a human decision, taken here or out-of-band.
      </Note>
    </Panel>
  );
}

/** The delivery timeline, from the customer-facing pure tracker. */
export function DeliveryTimeline({
  phase,
  progress,
  etaLabel,
  overdue,
  stages,
}: {
  phase: string;
  progress: number;
  etaLabel: string;
  overdue: boolean;
  stages: { id: string; label: string; hint: string; state: string; at: string | null }[];
}) {
  return (
    <Panel
      title="Delivery timeline"
      subtitle={`Same view the customer sees on /track — phase "${phase}", ${progress}% · ${etaLabel}${
        overdue ? " (overdue)" : ""
      }`}
      bodyClassName="px-4 py-3"
    >
      <ol className="space-y-2.5">
        {stages.map((stage) => (
          <li key={stage.id} className="flex items-start gap-2.5">
            <span
              aria-hidden
              className={
                stage.state === "done"
                  ? "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500"
                  : stage.state === "current"
                    ? "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500"
                    : stage.state === "failed"
                      ? "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-rose-500"
                      : "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600"
              }
            />
            <div className="min-w-0">
              <p className="text-[12px] font-semibold">
                {stage.label}
                {stage.state === "failed" && (
                  <span className="ml-1.5 text-[11px] font-normal text-rose-600 dark:text-rose-400">failed</span>
                )}
              </p>
              <p className="text-[11px] opacity-55">
                {stage.hint}
                {stage.at ? ` · ${formatDateTime(stage.at)}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <Note className="mt-3">
        Derived from the stored timestamps. A stage is never marked complete by this dashboard: only
        the provider, or an administrator through the audited support workflow, can do that.
      </Note>
    </Panel>
  );
}

/** The audit trail for this record — read-only, and the reason it can be trusted. */
export function RecordedActionsPanel({
  title,
  actions,
  available,
  emptyLabel,
  showRef = false,
}: {
  title: string;
  actions: AdminRecordedAction[];
  available: boolean;
  emptyLabel: string;
  showRef?: boolean;
}) {
  return (
    <Panel title={title} bodyClassName="px-4 py-3">
      {!available ? (
        <Note>
          Not available: this database does not have the administrator audit trail
          (`admin_audit_logs`). Apply the pending migrations to enable it.
        </Note>
      ) : actions.length === 0 ? (
        <Note>{emptyLabel}</Note>
      ) : (
        <ul className="divide-y divide-black/[0.04] dark:divide-white/[0.05]">
          {actions.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold">
                  {AUDIT_ACTION_LABELS[entry.action] ?? entry.action}
                  {showRef && entry.targetRef && (
                    <span className="ml-1.5 font-mono text-[11px] font-normal opacity-60">{entry.targetRef}</span>
                  )}
                </p>
                <p className="text-[11px] opacity-55">
                  {entry.adminName ?? `admin #${entry.adminUserId}`} · {formatDateTime(entry.createdAt)}
                </p>
                {entry.reason && <p className="mt-0.5 text-[11px] opacity-70">“{entry.reason}”</p>}
              </div>
              <Badge tone="mono">{entry.action}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Money and gateway facts, laid out for a reviewer. Display only. */
export function FactsPanel({
  title,
  subtitle,
  items,
  footer,
}: {
  title: string;
  subtitle?: string;
  items: { label: string; value: ReactNode; mono?: boolean }[];
  footer?: ReactNode;
}) {
  return (
    <Panel title={title} subtitle={subtitle} bodyClassName="px-4 py-3">
      <KeyValues items={items} />
      {footer}
    </Panel>
  );
}

/** Link to the one place an order can actually be acted on (Step 2 workflow). */
/**
 * `orderRef` rather than `ref`: `ref` is a reserved React prop, and a component
 * that quietly swallowed the reference it was meant to display would be a very
 * confusing way to lose the one identifier an operator needs.
 */
export function SupportWorkflowLink({
  orderRef,
  actionable,
}: {
  orderRef: string;
  actionable: boolean;
}) {
  return (
    <Note>
      {actionable ? (
        <>
          This order is eligible for a support action. Work it from{" "}
          <Link href="/admin/attention" className="font-semibold text-brand-deep hover:underline dark:text-brand">
            Requires support
          </Link>{" "}
          (mark delivered, or record a refund review) — both are explicitly confirmed and audited.
          Reference <span className="font-mono">{orderRef}</span>.
        </>
      ) : (
        <>
          No support action is available for this order in its current state. The Step 2 workflow only
          acts on orders with a captured payment that are unfulfilled, failed or stuck.
        </>
      )}
    </Note>
  );
}

/** Money formatting helper kept next to the panels that use it. */
export function money(amount: number | null, currency = "GHS"): string {
  return amount === null ? "Not available" : `${adminMoney(amount)} ${currency}`;
}

/** Small header used by the audit-trail page panels. */
export function TrailHeading({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <ScrollText className="h-3.5 w-3.5" strokeWidth={2.2} />
      {children}
    </span>
  );
}
