"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Radar } from "lucide-react";
import type { TxDTO } from "@/lib/data";
import { estimateDeliverySeconds, formatEtaCountdown } from "@/lib/fulfillment";
import { SectionTitle } from "@/components/ui";
import { groupPhone } from "@/lib/format";

/**
 * Home-screen strip of orders still being delivered, each with a live ETA
 * countdown. Gives the customer an at-a-glance answer to "how long until my
 * data arrives" without opening every order. Tapping one opens the full
 * tracker.
 */
export function ActiveDeliveries({ orders }: { orders: TxDTO[] }) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  if (orders.length === 0) return null;

  return (
    <div className="animate-fade-up mt-7" style={{ animationDelay: "300ms" }}>
      <SectionTitle title="Active deliveries" action="History" href="/history" />
      <div className="space-y-2.5">
        {orders.map((o) => {
          const created = new Date(o.date).getTime();
          const estimate = estimateDeliverySeconds({
            type: o.type,
            network: o.network,
            fulfillmentAttempts: 1,
          });
          const remaining = Math.round((created + estimate * 1000 - now) / 1000);
          const overdue = remaining <= 0;
          const countdown = formatEtaCountdown(Math.max(0, remaining), overdue);
          // Progress creeps toward — but never reaches — 100% until the server
          // confirms delivery, so a slow order never looks "done" prematurely.
          const pct = Math.min(92, Math.max(6, Math.round(((estimate - Math.max(0, remaining)) / estimate) * 92)));

          return (
            <Link
              key={o.id}
              href={`/track/${encodeURIComponent(o.ref)}`}
              className="block rounded-3xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3.5 transition-all hover:-translate-y-0.5 active:scale-[0.99]"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  <Radar className="h-[18px] w-[18px]" strokeWidth={2.3} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-bold">{o.title}</p>
                  <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    {o.recipient ? `To ${groupPhone(o.recipient)} • ` : ""}
                    <span className="font-bold text-amber-600 dark:text-amber-400">
                      {overdue ? "Arriving any moment" : `Arriving in ${countdown}`}
                    </span>
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-amber-500/70" />
              </div>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-amber-500/15">
                <div
                  className="h-full rounded-full bg-amber-500 transition-[width] duration-700 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
