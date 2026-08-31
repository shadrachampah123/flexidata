"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import type { AlertDTO } from "@/lib/data";
import { DropdownPanel } from "@/components/dropdown-panel";
import { cn } from "@/lib/format";

export function AlertsBell({ alerts }: { alerts: AlertDTO[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-label="Price alerts"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          "relative flex h-10 w-10 items-center justify-center rounded-2xl border border-black/5 bg-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-90 dark:border-line dark:bg-card",
          open && "ring-2 ring-brand/40",
        )}
      >
        <Bell className="h-[18px] w-[18px]" />
        {alerts.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-brand text-[9px] font-black text-ink ring-2 ring-white dark:ring-night">
            {alerts.length}
          </span>
        )}
      </button>

      <DropdownPanel
        open={open}
        anchorRef={triggerRef}
        onClose={close}
        align="right"
        width={300}
        maxHeight={360}
        label="Price drop alerts"
        className="rounded-3xl shadow-[0_24px_60px_rgba(0,0,0,0.2)]"
      >
        <div className="sticky top-0 border-b border-black/[0.05] bg-paper px-4 py-3 dark:border-line dark:bg-card2">
          <p className="font-display text-[13px] font-bold">Price drop alerts</p>
          <p className="text-[10px] text-zinc-400">Promos refreshed in real time</p>
        </div>
        <div className="p-2">
          {alerts.map((a) => (
            <Link
              key={a.id}
              href="/alerts"
              onClick={close}
              className="flex gap-3 rounded-2xl p-2.5 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <span
                className={cn(
                  "mt-0.5 flex h-7 shrink-0 items-center justify-center rounded-lg px-1.5 text-[9px] font-black",
                  a.network === "MTN" ? "bg-brand/20 text-brand-deep dark:text-brand" : "bg-telecel/15 text-telecel",
                )}
              >
                {a.tag}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-bold leading-snug">{a.title}</span>
                <span className="mt-0.5 line-clamp-2 block text-[10px] leading-snug text-zinc-500">
                  {a.body}
                </span>
              </span>
            </Link>
          ))}
          {alerts.length === 0 && (
            <p className="py-6 text-center text-xs text-zinc-400">No alerts right now</p>
          )}
        </div>
      </DropdownPanel>
    </div>
  );
}
