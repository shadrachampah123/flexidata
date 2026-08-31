"use client";

import { useMemo, useState } from "react";
import { Inbox } from "lucide-react";
import type { TxDTO } from "@/lib/data";
import { TxItem } from "@/components/tx-list";
import { Card, EmptyState } from "@/components/ui";
import { cn, dayLabel } from "@/lib/format";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "data", label: "Data" },
  { id: "airtime", label: "Airtime" },
  { id: "conversion", label: "Conversions" },
  { id: "deposit", label: "Deposits" },
  { id: "transfer", label: "Transfers" },
  { id: "redemption", label: "Rewards" },
];

export function History({ txs }: { txs: TxDTO[] }) {
  const [filter, setFilter] = useState("all");

  const filtered = useMemo(
    () => (filter === "all" ? txs : txs.filter((t) => t.type === filter)),
    [txs, filter],
  );

  const groups = useMemo(() => {
    const out: { label: string; items: TxDTO[] }[] = [];
    for (const t of filtered) {
      const label = dayLabel(t.date);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(t);
      else out.push({ label, items: [t] });
    }
    return out;
  }, [filtered]);

  return (
    <div>
      <div className="no-scrollbar animate-fade-up -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {FILTERS.map((f) => {
          const active = f.id === filter;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "shrink-0 rounded-full border px-3.5 py-2 text-[11px] font-bold transition-all active:scale-95",
                active
                  ? "border-brand bg-brand text-ink"
                  : "border-black/[0.06] bg-paper text-zinc-500 hover:border-brand/40 dark:border-line dark:bg-card dark:text-zinc-400",
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {groups.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={Inbox}
            title="Nothing here yet"
            body="Transactions in this category will appear here as soon as they happen."
            action="Buy data"
            href="/data"
          />
        </div>
      ) : (
        groups.map((g, gi) => (
          <div key={g.label} className="animate-fade-up mt-5" style={{ animationDelay: `${gi * 60}ms` }}>
            <p className="mb-2 px-1 text-[10px] font-black uppercase tracking-[0.16em] text-zinc-400">
              {g.label}
            </p>
            <Card className="overflow-hidden">
              <ul className="divide-y divide-black/[0.05] dark:divide-line">
                {g.items.map((t) => (
                  <TxItem key={t.id} t={t} />
                ))}
              </ul>
            </Card>
          </div>
        ))
      )}

      <p className="mt-6 text-center text-[10px] font-semibold text-zinc-400 dark:text-zinc-600">
        Showing the last {txs.length} transactions
      </p>
    </div>
  );
}
