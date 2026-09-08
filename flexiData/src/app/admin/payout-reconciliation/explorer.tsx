"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, ChevronLeft, ChevronRight, Play, CheckCircle2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/format";

const EXCEPTION_TYPES: Record<string, { label: string; color: string }> = {
  stuck_processing: { label: "Stuck Processing", color: "text-amber-600" },
  provider_success_local_processing: { label: "Provider Success / Local Processing", color: "text-blue-600" },
  provider_failure_local_processing: { label: "Provider Failure / Local Processing", color: "text-rose-600" },
  amount_mismatch: { label: "Amount Mismatch", color: "text-rose-600" },
  duplicate_provider_reference: { label: "Duplicate Provider Ref", color: "text-orange-600" },
  unknown_provider_reference: { label: "Unknown Provider Ref", color: "text-purple-600" },
  currency_mismatch: { label: "Currency Mismatch", color: "text-red-600" },
};

export function PayoutReconciliationExplorer({
  initialRows,
  initialTotal,
  initialPage,
  pageSize,
  initialFilters,
}: any) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [type, setType] = useState(initialFilters.type);
  const [resolved, setResolved] = useState(initialFilters.resolved);
  const [running, setRunning] = useState(false);

  const applyFilters = (overrides: Record<string, string>) => {
    const q = new URLSearchParams(searchParams.toString());
    const merged = { type, resolved, ...overrides };
    for (const [key, value] of Object.entries(merged)) {
      if (value) q.set(key, value);
      else q.delete(key);
    }
    q.set("page", "1");
    router.push(`?${q.toString()}`);
  };

  const handlePage = (p: number) => {
    const q = new URLSearchParams(searchParams.toString());
    q.set("page", p.toString());
    router.push(`?${q.toString()}`);
  };

  const runReconciliation = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/admin/payout-reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      });
      const body = await res.json();
      if (res.ok) {
        alert(`Reconciliation complete. ${body.newExceptions} new exception(s) found.`);
        router.refresh();
      } else {
        alert(body?.error || "Reconciliation failed");
      }
    } catch {
      alert("Error running reconciliation");
    } finally {
      setRunning(false);
    }
  };

  const resolveException = async (id: number) => {
    const note = window.prompt("Resolution note (optional):") || "";
    try {
      const res = await fetch("/api/admin/payout-reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve", exceptionId: id, note }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        const body = await res.json().catch(() => null);
        alert(body?.error || "Failed to resolve exception");
      }
    } catch {
      alert("Error resolving exception");
    }
  };

  const pages = Math.ceil(initialTotal / pageSize);

  return (
    <div className="rounded-2xl border border-black/[0.08] bg-white dark:border-line dark:bg-card overflow-hidden">
      {/* Controls */}
      <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            applyFilters({ type: e.target.value });
          }}
          className="rounded-xl border border-black/[0.08] bg-transparent py-2.5 px-3 text-[13px] font-medium outline-none dark:border-line"
        >
          <option value="">All Types</option>
          {Object.entries(EXCEPTION_TYPES).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <select
          value={resolved}
          onChange={(e) => {
            setResolved(e.target.value);
            applyFilters({ resolved: e.target.value });
          }}
          className="rounded-xl border border-black/[0.08] bg-transparent py-2.5 px-3 text-[13px] font-medium outline-none dark:border-line"
        >
          <option value="">All</option>
          <option value="false">Unresolved</option>
          <option value="true">Resolved</option>
        </select>
        <button
          onClick={runReconciliation}
          disabled={running}
          className="ml-auto rounded-xl bg-brand px-4 py-2.5 text-[13px] font-bold text-ink transition-all hover:-translate-y-0.5 disabled:opacity-50"
        >
          <span className="flex items-center gap-2">
            <Play className="h-4 w-4" />
            {running ? "Running..." : "Run Reconciliation"}
          </span>
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-y border-black/[0.06] bg-black/[0.02] text-zinc-500 dark:border-line dark:bg-white/[0.02] dark:text-zinc-400">
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Withdrawal</th>
              <th className="px-4 py-2 font-medium">Description</th>
              <th className="px-4 py-2 font-medium">Amounts</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.06] dark:divide-line">
            {initialRows.map((row: any) => {
              const typeInfo = EXCEPTION_TYPES[row.exception_type] || { label: row.exception_type, color: "text-zinc-600" };
              return (
                <tr key={row.id} className={cn("hover:bg-black/[0.02] dark:hover:bg-white/[0.02]", row.resolved && "opacity-50")}>
                  <td className="px-4 py-3">
                    <span className={cn("text-[11px] font-bold", typeInfo.color)}>
                      {typeInfo.label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-mono text-[11px] font-bold">{row.withdrawal_ref || "—"}</div>
                    {row.provider_reference && (
                      <div className="text-[10px] text-zinc-400 font-mono">{row.provider_reference}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 max-w-[300px]">
                    <div className="truncate" title={row.description}>{row.description}</div>
                  </td>
                  <td className="px-4 py-3">
                    {row.expected_amount && <div className="text-[11px]">Expected: {row.expected_amount} {row.currency}</div>}
                    {row.actual_amount && <div className="text-[11px]">Actual: {row.actual_amount} {row.currency}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase",
                      row.resolved ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    )}>
                      {row.resolved ? "Resolved" : "Open"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[11px] text-zinc-500">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!row.resolved && (
                      <button
                        onClick={() => resolveException(row.id)}
                        className="rounded p-1 text-emerald-600 hover:bg-emerald-100"
                        title="Mark as resolved"
                      >
                        <CheckCircle2 className="h-5 w-5" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {initialRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                  <div className="flex flex-col items-center gap-2">
                    <AlertTriangle className="h-6 w-6 text-zinc-300" />
                    <p>No reconciliation exceptions found.</p>
                    <p className="text-[11px]">Click &quot;Run Reconciliation&quot; to scan for mismatches.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-black/[0.06] p-4 text-[13px] dark:border-line">
          <div className="text-zinc-500">
            Showing {(initialPage - 1) * pageSize + 1} to {Math.min(initialPage * pageSize, initialTotal)} of {initialTotal}
          </div>
          <div className="flex gap-1">
            <button onClick={() => handlePage(initialPage - 1)} disabled={initialPage <= 1} className="rounded-lg p-1.5 hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button onClick={() => handlePage(initialPage + 1)} disabled={initialPage >= pages} className="rounded-lg p-1.5 hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
