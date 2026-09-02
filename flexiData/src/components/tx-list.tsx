import Link from "next/link";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ChevronRight,
  Gift,
  Radar,
  Send,
  Smartphone,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import type { TxDTO } from "@/lib/data";
import { cn, money, timeAgo } from "@/lib/format";
import { StatusBadge } from "@/components/ui";

const ICONS: Record<string, { icon: LucideIcon; cls: string }> = {
  data: { icon: Wifi, cls: "bg-brand/15 text-brand-deep dark:text-brand" },
  airtime: { icon: Smartphone, cls: "bg-violet-500/15 text-violet-500" },
  conversion: { icon: ArrowLeftRight, cls: "bg-emerald-500/15 text-emerald-500" },
  deposit: { icon: ArrowDownLeft, cls: "bg-sky-500/15 text-sky-500" },
  transfer: { icon: Send, cls: "bg-indigo-500/15 text-indigo-400" },
  redemption: { icon: Gift, cls: "bg-rose-500/15 text-rose-500" },
};

export function TxItem({ t, showDate }: { t: TxDTO; showDate?: boolean }) {
  const conf = ICONS[t.type] ?? ICONS.data;
  const Icon = conf.icon;
  const failed = t.status === "failed" || t.status === "reversed";
  const signed = t.direction === "in" ? t.amount : -t.amount;
  // A trackable order is worth opening the live tracker for as long as it is
  // not a hard failure; a pending one especially so, since that's where the
  // "how long until it arrives" question lives.
  const canTrack = t.trackable && t.status !== "failed";
  const pending = t.status === "pending";

  const body = (
    <>
      <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl", conf.cls)}>
        <Icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-bold">{t.title}</p>
        <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
          {showDate ? `${timeAgo(t.date)} • ` : ""}
          {t.subtitle}
        </p>
        {canTrack && (
          <span
            className={cn(
              "mt-1 inline-flex items-center gap-1 text-[10px] font-black",
              pending ? "text-amber-600 dark:text-amber-400" : "text-brand-deep dark:text-brand",
            )}
          >
            <Radar className="h-3 w-3" strokeWidth={2.6} />
            {pending ? "Track delivery" : "View tracking"}
            <ChevronRight className="h-3 w-3" />
          </span>
        )}
      </div>
      <div className="shrink-0 text-right">
        <p
          className={cn(
            "font-display text-[13px] font-bold tabular-nums",
            t.direction === "in"
              ? "text-emerald-500"
              : failed
                ? "text-zinc-400 line-through"
                : "text-[#18191f] dark:text-[#f2efe4]",
          )}
        >
          {t.amount > 0 ? money(signed, { sign: true }) : "—"}
        </p>
        <div className="mt-0.5 flex items-center justify-end gap-2">
          {t.points > 0 && (
            <span className="text-[9px] font-black text-brand-deep dark:text-brand">+{t.points} pts</span>
          )}
          <StatusBadge status={t.status} />
        </div>
      </div>
    </>
  );

  if (canTrack) {
    return (
      <li>
        <Link
          href={`/track/${encodeURIComponent(t.ref)}`}
          className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-black/[0.02] active:bg-black/[0.04] dark:hover:bg-white/[0.03]"
        >
          {body}
        </Link>
      </li>
    );
  }

  return <li className="flex items-center gap-3 px-4 py-3.5">{body}</li>;
}

export function TxList({ items, showDate }: { items: TxDTO[]; showDate?: boolean }) {
  return (
    <ul className="divide-y divide-black/[0.05] dark:divide-line">
      {items.map((t) => (
        <TxItem key={t.id} t={t} showDate={showDate} />
      ))}
    </ul>
  );
}
