"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftRight,
  Gift,
  History,
  House,
  LayoutGrid,
  Smartphone,
  Users,
  Wallet,
  Wifi,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/format";
import { APP_NAME } from "@/lib/constants";

const LINKS = [
  { href: "/", label: "Home", icon: House },
  { href: "/data", label: "Data", icon: Wifi },
  { href: "/airtime", label: "Airtime", icon: Smartphone },
  { href: "/convert", label: "Convert", icon: ArrowLeftRight },
  { href: "/rewards", label: "Rewards", icon: Gift },
  { href: "/wallet", label: "Wallet", icon: Wallet },
  { href: "/agent", label: "Agent", icon: Users },
  { href: "/history", label: "History", icon: History },
  { href: "/more", label: "More", icon: LayoutGrid },
];

export function SideNav() {
  const pathname = usePathname();
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[84px] flex-col items-center border-r border-black/5 bg-white/80 py-6 backdrop-blur-xl dark:border-line dark:bg-night/80 md:flex">
      <Link
        href="/"
        className="mb-8 flex flex-col items-center gap-2 active:scale-95"
        aria-label={APP_NAME}
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand text-ink shadow-[0_8px_20px_rgba(255,203,5,0.35)] transition-transform hover:rotate-6">
          <Zap className="h-5 w-5" strokeWidth={2.6} />
        </span>
        <span className="font-display text-[11px] font-bold leading-none tracking-tight">
          Flexi<span className="text-brand-deep dark:text-brand">Data</span>
        </span>
      </Link>
      <div className="flex w-full flex-1 flex-col items-center gap-1.5">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "group flex w-[64px] flex-col items-center gap-1 rounded-2xl py-2 transition-all active:scale-90",
                active ? "bg-brand/15" : "hover:bg-black/[0.04] dark:hover:bg-white/[0.04]",
              )}
            >
              <Icon
                className={cn(
                  "h-5 w-5 transition-colors",
                  active ? "text-brand-deep dark:text-brand" : "text-zinc-400 group-hover:text-zinc-600 dark:text-zinc-500",
                )}
                strokeWidth={active ? 2.4 : 2}
              />
              <span
                className={cn(
                  "text-[9px] font-bold tracking-wide",
                  active ? "text-[#18191f] dark:text-white" : "text-zinc-400 dark:text-zinc-500",
                )}
              >
                {label}
              </span>
            </Link>
          );
        })}
      </div>
      <div className="mt-6 h-1.5 w-1.5 rounded-full bg-brand" />
    </aside>
  );
}
