import Link from "next/link";
import { CalendarClock, ChevronRight, Zap } from "lucide-react";
import {
  getActiveAlerts,
  getActiveDeliveries,
  getRecentTransactions,
  getSchedules,
} from "@/lib/data";
import { requireSession } from "@/lib/session";
import { WalletCard } from "@/components/wallet-card";
import { ServiceGrid } from "@/components/service-grid";
import { TxList } from "@/components/tx-list";
import { ActiveDeliveries } from "@/components/active-deliveries";
import { AlertsBell } from "@/components/alerts-bell";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card, Logo, SectionTitle } from "@/components/ui";
import { APP_NAME } from "@/lib/constants";
import { money, ordinal } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { user, wallet } = await requireSession();
  const [txs, alerts, schedules, activeDeliveries] = await Promise.all([
    getRecentTransactions(wallet.id, 7),
    getActiveAlerts(),
    getSchedules(wallet.id),
    getActiveDeliveries(wallet.id),
  ]);

  const first = wallet.name.split(" ")[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const nextSchedule = schedules.find((s) => s.active);

  return (
    <div>
      {/* Header */}
      <header className="animate-fade-up">
        <div className="flex items-center justify-between">
          <Logo />
          <div className="flex items-center gap-2">
            <AlertsBell alerts={alerts} />
            <ThemeToggle />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Link href="/settings" className="shrink-0">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand to-amber-500 font-display text-sm font-bold text-ink shadow-[0_6px_16px_rgba(255,203,5,0.35)] transition-transform hover:scale-105">
              {first[0]}
            </span>
          </Link>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-zinc-400">{greeting},</p>
            <h1 className="truncate font-display text-[17px] font-bold leading-tight tracking-tight">
              {first}
            </h1>
          </div>
          <span className="hidden rounded-full border border-black/[0.06] px-2.5 py-1 text-[10px] font-bold text-zinc-500 dark:border-line dark:text-zinc-400 sm:block">
            {wallet.number.replace(/(\d{3})(\d{3})(\d{4})/, "$1 $2 $3")}
          </span>
        </div>
      </header>

      {/* Promo ticker */}
      {alerts.length > 0 && (
        <Link
          href="/alerts"
          className="animate-fade-up mt-5 flex items-center overflow-hidden rounded-2xl bg-brand text-ink shadow-[0_8px_20px_rgba(255,203,5,0.25)]"
          style={{ animationDelay: "60ms" }}
        >
          <span className="flex shrink-0 items-center gap-1.5 bg-ink px-3 py-2.5 text-[10px] font-black tracking-widest text-brand">
            <Zap className="h-3 w-3" strokeWidth={3} />
            DROPS
          </span>
          <div className="relative flex-1 overflow-hidden py-2.5">
            <div className="animate-marquee flex w-max gap-10 whitespace-nowrap px-4">
              {[...alerts, ...alerts].map((a, i) => (
                <span key={i} className="flex items-center gap-2 text-[11px] font-bold">
                  <span className="rounded-md bg-ink/10 px-1.5 py-0.5 text-[9px] font-black">{a.tag}</span>
                  {a.title}
                </span>
              ))}
            </div>
          </div>
        </Link>
      )}

      {/* Wallet */}
      <div className="mt-5">
        <WalletCard wallet={wallet} />
      </div>

      {/* Quick services */}
      <div className="mt-7">
        <SectionTitle title="Quick services" />
        <ServiceGrid />
      </div>

      {/* Active deliveries — live ETA for orders still in flight */}
      <ActiveDeliveries orders={activeDeliveries} />

      {/* Upcoming auto top-up */}
      {nextSchedule && (
        <Link
          href="/schedule"
          className="animate-fade-up mt-5 flex items-center gap-3 rounded-3xl border border-indigo-500/20 bg-indigo-500/[0.06] px-4 py-3.5 transition-all hover:bg-indigo-500/10 active:scale-[0.98]"
          style={{ animationDelay: "420ms" }}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-500 dark:text-indigo-400">
            <CalendarClock className="h-[18px] w-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-bold">
              Auto top-up on the {ordinal(nextSchedule.dayOfMonth)}
            </span>
            <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {nextSchedule.network} {nextSchedule.planLabel} → {nextSchedule.recipient} •{" "}
              {money(nextSchedule.price)}
            </span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
        </Link>
      )}

      {/* Recent transactions */}
      <div className="mt-7">
        <SectionTitle title="Recent transactions" action="See all" href="/history" />
        {txs.length === 0 ? (
          <Card className="animate-fade-up p-6 text-center">
            <p className="text-sm font-bold">No transactions yet</p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Fund your wallet or buy your first bundle to get started.
            </p>
            <Link
              href="/wallet"
              className="mt-4 inline-flex rounded-xl bg-brand px-4 py-2.5 text-xs font-black text-ink"
            >
              Fund wallet
            </Link>
          </Card>
        ) : (
          <Card className="animate-fade-up overflow-hidden">
            <TxList items={txs} showDate />
          </Card>
        )}
      </div>

      <p className="mt-8 text-center text-[10px] font-semibold tracking-wide text-zinc-400 dark:text-zinc-600">
        {APP_NAME} • Signed in as {user.email}
      </p>
    </div>
  );
}
