"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, ChevronLeft, ChevronRight, CheckCircle2, XCircle, RotateCcw, Clock, AlertTriangle } from "lucide-react";
import { cn, money } from "@/lib/format";
import { FieldLabel } from "@/components/ui";

export function WithdrawalsExplorer({
  initialRows,
  initialTotal,
  initialPage,
  pageSize,
  initialFilters,
  actionsBlocked = false,
}: any) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [search, setSearch] = useState(initialFilters.search);
  const [status, setStatus] = useState(initialFilters.status);
  const [method, setMethod] = useState(initialFilters.method || "");
  const [confirmAction, setConfirmAction] = useState<{ id: string; action: string; label: string } | null>(null);

  const applyFilters = (overrides: Record<string, string>) => {
    const q = new URLSearchParams(searchParams.toString());
    const merged = { search, status, method, ...overrides };
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

  const pages = Math.ceil(initialTotal / pageSize);

  const handleAction = async (id: string, action: "approve" | "reject" | "refund" | "retry") => {
    let reason = "";
    if (action === "reject" || action === "refund") {
      reason = window.prompt(`${action === "refund" ? "Refund" : "Rejection"} reason:`) || "";
      if (!reason) return;
    } else if (action === "retry") {
      if (!window.confirm("Retry payout initiation? It will reuse the same provider reference — never a second transfer.")) return;
    } else {
      if (!window.confirm("Approve this withdrawal? It will be moved to processing (awaiting payout).")) return;
    }

    try {
      const res = await fetch(`/api/admin/withdrawals/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        router.refresh();
      } else {
        alert(body?.error || "Failed to process action.");
      }
    } catch {
      alert("Error occurred.");
    }
  };

  const statusLabel = (s: string) => {
    const colors: Record<string, string> = {
      pending: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
      processing: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
      successful: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
      rejected: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
      refunded: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
      failed: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
    };
    return colors[s] || "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400";
  };

  const methodLabel = (m: string) => {
    if (m === "momo_mtn") return "MTN MoMo";
    if (m === "telecel_cash") return "Telecel Cash";
    return m;
  };

  return (
    <div className="rounded-2xl border border-black/[0.08] bg-white dark:border-line dark:bg-card overflow-hidden">
      {/* Filters */}
      <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Search ref, email, wallet, or destination..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyFilters({})}
            className="w-full rounded-xl border border-black/[0.08] bg-transparent py-2.5 pl-9 pr-4 text-[13px] font-medium outline-none focus:border-brand dark:border-line dark:focus:border-brand"
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            applyFilters({ status: e.target.value });
          }}
          className="rounded-xl border border-black/[0.08] bg-transparent py-2.5 px-3 text-[13px] font-medium outline-none dark:border-line"
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="successful">Successful</option>
          <option value="rejected">Rejected</option>
          <option value="refunded">Refunded</option>
          <option value="failed">Failed</option>
        </select>
        <select
          value={method}
          onChange={(e) => {
            setMethod(e.target.value);
            applyFilters({ method: e.target.value });
          }}
          className="rounded-xl border border-black/[0.08] bg-transparent py-2.5 px-3 text-[13px] font-medium outline-none dark:border-line"
        >
          <option value="">All Methods</option>
          <option value="momo_mtn">MTN MoMo</option>
          <option value="telecel_cash">Telecel Cash</option>
        </select>
      </div>

      {/* Summary bar */}
      <div className="flex items-center gap-4 border-t border-black/[0.06] px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-zinc-500 dark:border-line dark:text-zinc-400">
        <span>{initialTotal} total</span>
        <span className="text-amber-600">{initialRows.filter((r: any) => r.status === "pending").length} pending</span>
        <span className="text-blue-600">{initialRows.filter((r: any) => r.status === "processing").length} processing</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-y border-black/[0.06] bg-black/[0.02] text-zinc-500 dark:border-line dark:bg-white/[0.02] dark:text-zinc-400">
              <th className="px-4 py-2 font-medium">Ref & Date</th>
              <th className="px-4 py-2 font-medium">User</th>
              <th className="px-4 py-2 font-medium">Amount / Fee / Net</th>
              <th className="px-4 py-2 font-medium">Destination</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.06] dark:divide-line">
            {initialRows.map((row: any) => (
              <tr key={row.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                <td className="px-4 py-3">
                  <div className="font-mono text-[11px] font-bold">{row.ref}</div>
                  <div className="text-[11px] text-zinc-500">
                    {new Date(row.createdAt).toLocaleString()}
                  </div>
                  {row.processedAt && (
                    <div className="text-[10px] text-zinc-400">
                      Processed: {new Date(row.processedAt).toLocaleString()}
                    </div>
                  )}
                  {row.completedAt && (
                    <div className="text-[10px] text-zinc-400">
                      Completed: {new Date(row.completedAt).toLocaleString()}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-ink dark:text-white">{row.userEmail}</div>
                  <div className="text-[11px] text-zinc-500">{row.walletNumber}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="font-bold text-ink dark:text-white">{money(row.netAmount)}</div>
                  <div className="text-[11px] text-zinc-500">
                    Gross: {money(row.amount)} | Fee: {money(row.fee)}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium">{row.dest}</div>
                  <div className="text-[11px] text-zinc-500 uppercase">
                    {methodLabel(row.method)} {row.network ? `(${row.network})` : ""}
                  </div>
                  {row.providerReference && (
                    <div className="text-[10px] text-zinc-400 font-mono mt-0.5">
                      {row.providerReference}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={cn(
                    "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                    statusLabel(row.status),
                  )}>
                    {row.status}
                  </span>
                  {row.rejectionReason && (
                    <div className="mt-1 text-[10px] text-rose-500 max-w-[200px] truncate" title={row.rejectionReason}>
                      {row.rejectionReason}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    {row.status === "pending" && (
                      <>
                        <button
                          onClick={() => handleAction(row.id, "approve")}
                          disabled={actionsBlocked}
                          title={actionsBlocked ? "Blocked: audit schema upgrade needed" : "Approve (move to processing)"}
                          className="rounded p-1 text-emerald-600 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <CheckCircle2 className="h-5 w-5" />
                        </button>
                        <button
                          onClick={() => handleAction(row.id, "reject")}
                          disabled={actionsBlocked}
                          title={actionsBlocked ? "Blocked: audit schema upgrade needed" : "Reject (refund to wallet)"}
                          className="rounded p-1 text-rose-600 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <XCircle className="h-5 w-5" />
                        </button>
                      </>
                    )}
                    {row.status === "processing" && (
                      <>
                        <button
                          onClick={() => handleAction(row.id, "retry")}
                          disabled={actionsBlocked}
                          title="Retry payout initiation (reuses the same provider reference — never a second transfer)"
                          className="rounded p-1 text-blue-600 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Clock className="h-5 w-5" />
                        </button>
                        <button
                          onClick={() => handleAction(row.id, "refund")}
                          disabled={actionsBlocked}
                          title="Refund (return funds to wallet)"
                          className="rounded p-1 text-orange-600 transition-colors hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <RotateCcw className="h-5 w-5" />
                        </button>
                      </>
                    )}
                    {(row.status === "successful" || row.status === "rejected" || row.status === "refunded") && (
                      <span className="text-[10px] text-zinc-400">—</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {initialRows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                  No withdrawals found.
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
            <button
              onClick={() => handlePage(initialPage - 1)}
              disabled={initialPage <= 1}
              className="rounded-lg p-1.5 hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => handlePage(initialPage + 1)}
              disabled={initialPage >= pages}
              className="rounded-lg p-1.5 hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
