"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { cn } from "@/lib/format";

/**
 * The generic admin list: server-rendered first paint, client-side filtering
 * and pagination afterwards.
 *
 * A page fetches page 1 through the read-only query layer (so the first paint
 * works with JavaScript disabled and is never dependent on a second round trip)
 * and hands the rows to this component, which then pages and filters through the
 * matching `/api/admin/*` endpoint — every one of which re-runs the Phase 0
 * authorization gate before answering.
 *
 * Nothing here writes. The only HTTP method used is GET.
 */

export type AdminColumn<T> = {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  className?: string;
  headerClassName?: string;
  cell: (row: T) => ReactNode;
};

export type AdminFilterField = {
  name: string;
  label: string;
  type: "text" | "select" | "date" | "number";
  options?: { value: string; label: string }[];
  placeholder?: string;
};

export type AdminExplorerProps<T> = {
  /** `/api/admin/…` endpoint that backs this list. */
  endpoint: string;
  columns: AdminColumn<T>[];
  filters?: AdminFilterField[];
  /** Filter values the server rendered with (usually read from the URL). */
  initialFilters?: Record<string, string>;
  initialRows: T[];
  initialTotal: number;
  initialPage?: number;
  pageSize: number;
  emptyLabel: string;
  rowKey: (row: T, index: number) => string;
  /** Extra query parameters that never change (e.g. a fixed channel). */
  fixedParams?: Record<string, string>;
  note?: ReactNode;
  toolbar?: ReactNode;
};

export function AdminExplorer<T>({
  endpoint,
  columns,
  filters = [],
  initialFilters = {},
  initialRows,
  initialTotal,
  initialPage = 1,
  pageSize,
  emptyLabel,
  rowKey,
  fixedParams,
  note,
  toolbar,
}: AdminExplorerProps<T>) {
  const [rows, setRows] = useState<T[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [query, setQuery] = useState({ page: initialPage, filters: { ...initialFilters } });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstRender = useRef(true);

  const load = async (page: number, filterValues: Record<string, string>) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(fixedParams ?? {})) params.set(key, value);
      for (const [key, value] of Object.entries(filterValues)) {
        if (value) params.set(key, value);
      }
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));

      const response = await fetch(`${endpoint}?${params.toString()}`, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 404) {
        setError("This view is no longer available — your admin session may have ended.");
        return;
      }
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      const payload = (await response.json()) as { ok?: boolean; rows?: T[]; total?: number };
      setRows(payload.rows ?? []);
      setTotal(payload.total ?? 0);
    } catch {
      setError("Could not load this view. Reload the page to try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    // Debounced so typing a name does not fire a request per keystroke.
    const timer = setTimeout(() => void load(query.page, query.filters), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const setFilter = (name: string, value: string) => {
    setQuery((current) => ({ page: 1, filters: { ...current.filters, [name]: value } }));
  };

  const resetFilters = () => setQuery({ page: 1, filters: {} });

  const activeFilters = Object.entries(query.filters).filter(([, value]) => Boolean(value));
  const from = total === 0 ? 0 : (query.page - 1) * pageSize + 1;
  const to = Math.min(query.page * pageSize, total);

  return (
    <div className="space-y-3">
      {(filters.length > 0 || toolbar) && (
        <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-black/[0.06] bg-paper px-3 py-3 dark:border-line dark:bg-card">
          {filters.map((field) => {
            const value = query.filters[field.name] ?? "";
            const label = (
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
                {field.label}
              </span>
            );
            return (
              <div key={field.name} className={cn("min-w-[130px] flex-1", field.type === "date" && "min-w-[150px]")}>
                <label>
                  {label}
                  {field.type === "select" ? (
                    <select
                      value={value}
                      onChange={(event) => setFilter(field.name, event.target.value)}
                      className="h-9 w-full rounded-xl border border-black/[0.08] bg-white px-2 text-[13px] outline-none focus:border-brand dark:border-line dark:bg-card2"
                    >
                      <option value="">All</option>
                      {(field.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : field.type === "text" ? (
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-40" />
                      <input
                        type="text"
                        value={value}
                        onChange={(event) => setFilter(field.name, event.target.value)}
                        placeholder={field.placeholder}
                        className="h-9 w-full rounded-xl border border-black/[0.08] bg-white pl-8 pr-2 text-[13px] outline-none placeholder:opacity-50 focus:border-brand dark:border-line dark:bg-card2"
                      />
                    </div>
                  ) : (
                    <input
                      type={field.type}
                      value={value}
                      onChange={(event) => setFilter(field.name, event.target.value)}
                      className="h-9 w-full rounded-xl border border-black/[0.08] bg-white px-2 text-[13px] outline-none focus:border-brand dark:border-line dark:bg-card2"
                    />
                  )}
                </label>
              </div>
            );
          })}
          {activeFilters.length > 0 && (
            <button
              type="button"
              onClick={resetFilters}
              className="flex h-9 items-center gap-1 rounded-xl border border-black/[0.08] px-3 text-[12px] font-semibold opacity-70 transition-opacity hover:opacity-100 dark:border-line"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
          {toolbar}
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-black/[0.06] bg-paper dark:border-line dark:bg-card">
        <table className="w-full min-w-[860px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-black/[0.06] bg-black/[0.015] dark:border-line dark:bg-white/[0.02]">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    "whitespace-nowrap px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-500 dark:text-zinc-400",
                    column.align === "right" && "text-right",
                    column.align === "center" && "text-center",
                    column.headerClassName,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={cn("divide-y divide-black/[0.04] dark:divide-white/[0.05]", loading && "opacity-50")}>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-10 text-center text-[13px] opacity-55">
                  {error ?? emptyLabel}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={rowKey(row, index)} className="align-top hover:bg-black/[0.015] dark:hover:bg-white/[0.02]">
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        "px-3 py-2.5 align-top",
                        column.align === "right" && "text-right",
                        column.align === "center" && "text-center",
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-[12px] opacity-60">
          {error ? (
            <span className="text-rose-600 dark:text-rose-400">{error}</span>
          ) : (
            <>
              {total === 0 ? "No records" : `Showing ${from}–${to} of ${total.toLocaleString("en-GH")}`}
              {loading && " · loading…"}
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={query.page <= 1 || loading}
            onClick={() => setQuery((current) => ({ ...current, page: Math.max(1, current.page - 1) }))}
            className="flex h-8 items-center gap-1 rounded-lg border border-black/[0.08] px-2.5 text-[12px] font-semibold disabled:opacity-40 dark:border-line"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Previous
          </button>
          <span className="text-[12px] tabular-nums opacity-60">Page {query.page}</span>
          <button
            type="button"
            disabled={loading || (total > 0 && query.page * pageSize >= total)}
            onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))}
            className="flex h-8 items-center gap-1 rounded-lg border border-black/[0.08] px-2.5 text-[12px] font-semibold disabled:opacity-40 dark:border-line"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {note && <div className="px-1 text-[11px] leading-relaxed opacity-55">{note}</div>}
    </div>
  );
}
