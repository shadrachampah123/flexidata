"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, Gift, House, LayoutGrid, Wifi } from "lucide-react";
import { cn } from "@/lib/format";

function Item({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: typeof House;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group relative flex flex-1 flex-col items-center gap-1 py-2.5 transition-all active:scale-90",
      )}
    >
      <Icon
        className={cn(
          "h-[21px] w-[21px] transition-colors",
          active ? "text-brand" : "text-zinc-400 group-hover:text-zinc-600 dark:text-zinc-500 dark:group-hover:text-zinc-300",
        )}
        strokeWidth={active ? 2.4 : 2}
      />
      <span
        className={cn(
          "text-[10px] font-bold tracking-wide transition-colors",
          active ? "text-[#18191f] dark:text-white" : "text-zinc-400 dark:text-zinc-500",
        )}
      >
        {label}
      </span>
      {active && <span className="absolute -top-px h-[3px] w-8 rounded-full bg-brand" />}
    </Link>
  );
}

export function BottomNav() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-black/5 bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl dark:border-line dark:bg-night/90 md:hidden">
      <div className="mx-auto flex w-full max-w-[520px] items-end px-2">
        <Item href="/" label="Home" icon={House} active={isActive("/")} />
        <Item href="/data" label="Data" icon={Wifi} active={isActive("/data")} />
        <div className="relative flex flex-1 flex-col items-center">
          <Link
            href="/convert"
            aria-label="Airtime to Cash"
            className={cn(
              "absolute -top-9 flex h-[54px] w-[54px] items-center justify-center rounded-full bg-brand text-ink shadow-[0_10px_24px_rgba(255,203,5,0.45)] ring-4 ring-white transition-all hover:scale-105 active:scale-95 dark:ring-night",
              isActive("/convert") && "animate-ring-pulse",
            )}
          >
            <ArrowLeftRight className="h-[22px] w-[22px]" strokeWidth={2.4} />
          </Link>
          <span
            className={cn(
              "mt-7 pb-2 text-[10px] font-bold tracking-wide",
              isActive("/convert") ? "text-[#18191f] dark:text-white" : "text-zinc-400 dark:text-zinc-500",
            )}
          >
            Convert
          </span>
        </div>
        <Item href="/rewards" label="Rewards" icon={Gift} active={isActive("/rewards")} />
        <Item href="/more" label="More" icon={LayoutGrid} active={isActive("/more")} />
      </div>
    </nav>
  );
}
