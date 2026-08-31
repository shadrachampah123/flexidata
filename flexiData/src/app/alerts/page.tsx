import Link from "next/link";
import { BellRing, ChevronRight, Flame } from "lucide-react";
import { getActiveAlerts, getWallet } from "@/lib/data";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const [alerts, wallet] = await Promise.all([getActiveAlerts(), getWallet()]);

  return (
    <div>
      <PageHeader title="Price Drop Alerts" subtitle="Promotional rates, live now" balance={wallet.balance} />
      <div className="space-y-4">
        {alerts.map((a, i) => (
          <Link
            key={a.id}
            href="/data"
            style={{ animationDelay: `${i * 80}ms` }}
            className="animate-fade-up group block overflow-hidden rounded-[1.75rem] border border-black/[0.05] bg-paper shadow-sm transition-all hover:-translate-y-0.5 active:scale-[0.99] dark:border-line dark:bg-card"
          >
            <div
              className={cn(
                "flex items-center justify-between px-5 py-3",
                a.network === "MTN" ? "bg-brand text-ink" : "bg-telecel text-white",
              )}
            >
              <span className="text-[10px] font-black tracking-[0.18em]">{a.network} NETWORK</span>
              <span className="flex items-center gap-1 text-[10px] font-black">
                <Flame className="h-3 w-3" /> {a.tag}
              </span>
            </div>
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-[15px] font-bold leading-snug tracking-tight">
                  {a.title}
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{a.body}</p>
              </div>
              <ChevronRight className="h-5 w-5 shrink-0 text-zinc-300 transition-transform group-hover:translate-x-1 dark:text-zinc-600" />
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-3 rounded-3xl border border-dashed border-brand/40 bg-brand/[0.06] px-4 py-4">
        <BellRing className="h-5 w-5 shrink-0 text-brand-deep dark:text-brand" />
        <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          You&rsquo;ll see a banner on your dashboard whenever a new promotional rate drops. No spam —
          only real savings.
        </p>
      </div>
    </div>
  );
}
