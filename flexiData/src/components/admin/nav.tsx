"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeftRight,
  Gauge,
  LifeBuoy,
  PackageSearch,
  PieChart,
  Users,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/format";

/**
 * Admin navigation.
 *
 * Pure chrome: it renders links and the "requires support" counter passed down
 * from the (server-authorised) layout. It performs no authorization of its own
 * and holds no data — hiding a link is never the control, the layout gate is.
 */

export type AdminNavBadges = { support: number | null; stuck: number | null };

const LINKS = [
  { href: "/admin", label: "Overview", icon: Gauge, exact: true },
  { href: "/admin/attention", label: "Requires support", icon: LifeBuoy, badge: "support" as const },
  { href: "/admin/data", label: "Data operations", icon: PackageSearch },
  { href: "/admin/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/admin/payments", label: "Payments", icon: Wallet },
  { href: "/admin/wallets", label: "Wallets", icon: PieChart },
  { href: "/admin/reconciliation", label: "Reconciliation", icon: AlertTriangle },
  { href: "/admin/users", label: "Customers", icon: Users },
];

export function AdminNav({ badges }: { badges: AdminNavBadges }) {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 overflow-x-auto px-3 py-2 md:flex-col md:overflow-visible md:px-2 md:py-3">
      {LINKS.map((link) => {
        const active = link.exact ? pathname === link.href : pathname.startsWith(link.href);
        const badgeValue = link.badge === "support" ? badges.support : null;
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-semibold transition-colors md:w-full",
              active
                ? "bg-brand/15 text-brand-deep dark:bg-brand/20 dark:text-brand"
                : "text-zinc-600 hover:bg-black/[0.04] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.05] dark:hover:text-white",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" strokeWidth={2.2} />
            <span className="whitespace-nowrap">{link.label}</span>
            {badgeValue !== null && badgeValue > 0 && (
              <span className="ml-auto inline-flex min-w-[20px] items-center justify-center rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                {badgeValue > 99 ? "99+" : badgeValue}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
