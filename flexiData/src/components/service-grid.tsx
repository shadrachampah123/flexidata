import Link from "next/link";
import {
  ArrowLeftRight,
  CalendarClock,
  Gift,
  Smartphone,
  Users,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/format";

const SERVICES: { href: string; label: string; icon: LucideIcon; cls: string; primary?: boolean }[] = [
  { href: "/data", label: "Buy Data", icon: Wifi, cls: "bg-brand text-ink", primary: true },
  { href: "/airtime", label: "Buy Airtime", icon: Smartphone, cls: "bg-violet-500/15 text-violet-500" },
  { href: "/convert", label: "Airtime → Cash", icon: ArrowLeftRight, cls: "bg-emerald-500/15 text-emerald-500" },
  { href: "/agent", label: "Agent", icon: Users, cls: "bg-sky-500/15 text-sky-500" },
  { href: "/rewards", label: "Rewards", icon: Gift, cls: "bg-rose-500/15 text-rose-500" },
  { href: "/schedule", label: "Auto Top-up", icon: CalendarClock, cls: "bg-indigo-500/15 text-indigo-400" },
];

export function ServiceGrid() {
  return (
    <div className="grid grid-cols-3 gap-2.5">
      {SERVICES.map((s, i) => (
        <Link
          key={s.href}
          href={s.href}
          style={{ animationDelay: `${120 + i * 60}ms` }}
          className={cn(
            "animate-fade-up group flex flex-col items-start gap-2.5 rounded-[1.4rem] border border-black/[0.05] bg-paper p-3.5 shadow-[0_2px_10px_rgba(24,25,31,0.04)] transition-all hover:-translate-y-1 hover:shadow-[0_10px_24px_rgba(24,25,31,0.08)] active:scale-95 dark:border-line dark:bg-card",
            s.primary && "border-brand/40 dark:border-brand/25",
          )}
        >
          <span
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-xl transition-transform group-hover:scale-110 group-hover:-rotate-3",
              s.cls,
            )}
          >
            <s.icon className="h-[17px] w-[17px]" strokeWidth={2.3} />
          </span>
          <span className="text-[11px] font-bold leading-tight">{s.label}</span>
        </Link>
      ))}
    </div>
  );
}
