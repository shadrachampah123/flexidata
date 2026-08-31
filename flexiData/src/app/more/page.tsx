import Link from "next/link";
import {
  Bell,
  CalendarClock,
  ChevronRight,
  Gift,
  Headset,
  History,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { getActiveAlerts } from "@/lib/data";
import { ThemeToggle } from "@/components/theme-toggle";
import { PageHeader } from "@/components/page-header";
import { APP_TAGLINE } from "@/lib/constants";
import { requireSession } from "@/lib/session";
import { cn, fmtPoints } from "@/lib/format";
import { LogoutButton } from "@/components/logout-button";

export const dynamic = "force-dynamic";

type Row = {
  href: string;
  icon: LucideIcon;
  cls: string;
  label: string;
  sub: string;
  badge?: string;
};

export default async function MorePage() {
  const [{ user, wallet }, alerts] = await Promise.all([requireSession(), getActiveAlerts()]);

  const rows: Row[] = [
    { href: "/settings", icon: Settings, cls: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300", label: "Settings", sub: "Profile, security & notifications" },
    { href: "/wallet", icon: Wallet, cls: "bg-sky-500/15 text-sky-500", label: "Fund Wallet & Transfer", sub: "MTN MoMo, Telecel Cash or card" },
    { href: "/history", icon: History, cls: "bg-indigo-500/15 text-indigo-400", label: "Transaction History", sub: "Filter your full ledger" },
    { href: "/schedule", icon: CalendarClock, cls: "bg-emerald-500/15 text-emerald-500", label: "Auto Top-up", sub: "Recurring bundles each month" },
    { href: "/agent", icon: Users, cls: "bg-brand/15 text-brand-deep dark:text-brand", label: "Agent Program", sub: wallet.isAgent ? `${wallet.agentTier} agent — view portal` : "Wholesale rates & referrals" },
    { href: "/alerts", icon: Bell, cls: "bg-rose-500/15 text-rose-500", label: "Price Drop Alerts", sub: "Promotional rates in real time", badge: `${alerts.length} live` },
    { href: "/rewards", icon: Gift, cls: "bg-violet-500/15 text-violet-500", label: "Rewards & Points", sub: `${fmtPoints(wallet.points)} pts to redeem` },
  ];

  return (
    <div>
      <PageHeader title="More" subtitle={APP_TAGLINE} />

      {/* Profile card */}
      <Link
        href="/settings"
        className="animate-fade-up flex items-center gap-4 rounded-[1.75rem] border border-black/[0.05] bg-paper p-5 shadow-sm transition-transform hover:scale-[1.01] dark:border-line dark:bg-card"
      >
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-amber-500 font-display text-lg font-bold text-ink shadow-[0_8px_20px_rgba(255,203,5,0.35)]">
          {wallet.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display truncate text-[16px] font-bold tracking-tight">{wallet.name}</p>
          <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{user.email}</p>
          <p className="font-mono text-[11px] tracking-wider text-zinc-500">
            {wallet.number.replace(/(\d{3})(\d{3})(\d{4})/, "$1 $2 $3")}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[9px] font-black text-brand-deep dark:text-brand">
              {fmtPoints(wallet.points)} PTS
            </span>
            <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[9px] font-black text-sky-600 dark:text-sky-400">
              REF {user.referralCode}
            </span>
            {wallet.isAgent && (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] font-black text-emerald-600 dark:text-emerald-400">
                {wallet.agentTier?.toUpperCase()} AGENT
              </span>
            )}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300 dark:text-zinc-600" />
      </Link>

      {/* Menu */}
      <div className="animate-fade-up mt-5 divide-y divide-black/[0.05] overflow-hidden rounded-[1.75rem] border border-black/[0.05] bg-paper shadow-sm dark:divide-line dark:border-line dark:bg-card" style={{ animationDelay: "80ms" }}>
        {rows.map((r) => (
          <Link
            key={r.href}
            href={r.href}
            className="flex items-center gap-3.5 px-4 py-4 transition-colors hover:bg-black/[0.02] active:bg-black/[0.04] dark:hover:bg-white/[0.03]"
          >
            <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", r.cls)}>
              <r.icon className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-bold">{r.label}</span>
              <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">{r.sub}</span>
            </span>
            {r.badge && (
              <span className="shrink-0 rounded-full bg-rose-500/15 px-2 py-0.5 text-[9px] font-black text-rose-500">
                {r.badge}
              </span>
            )}
            <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300 dark:text-zinc-600" />
          </Link>
        ))}
        <div className="flex items-center gap-3.5 px-4 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-500/15 text-zinc-500 dark:text-zinc-300">
            <ShieldCheck className="h-[18px] w-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-bold">Appearance</span>
            <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">Switch between dark & light</span>
          </span>
          <ThemeToggle />
        </div>
      </div>

      {/* Logout */}
      <div className="animate-fade-up mt-5 overflow-hidden rounded-[1.75rem] border border-rose-500/20 bg-rose-500/[0.04] shadow-sm" style={{ animationDelay: "140ms" }}>
        <LogoutButton />
      </div>

      {/* Support */}
      <div className="animate-fade-up mt-5 rounded-[1.75rem] border border-black/[0.05] bg-paper p-5 shadow-sm dark:border-line dark:bg-card" style={{ animationDelay: "200ms" }}>
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/15 text-brand-deep dark:text-brand">
            <Headset className="h-5 w-5" />
          </span>
          <div>
            <p className="font-display text-sm font-bold">Help & Support</p>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">We&rsquo;re online 24/7, including holidays</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-black/[0.03] px-3 py-2.5 text-xs font-bold dark:bg-white/[0.05]">
          support@flexidata.app
        </div>
      </div>
    </div>
  );
}

export function LogoutRowIcon() {
  return <LogOut className="h-[18px] w-[18px]" />;
}
