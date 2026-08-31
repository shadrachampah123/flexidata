import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { money } from "@/lib/format";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  backHref = "/",
  balance,
  right,
}: {
  title: string;
  subtitle?: string;
  backHref?: string;
  balance?: number;
  right?: ReactNode;
}) {
  return (
    <header className="mb-6 flex items-center gap-3">
      <Link
        href={backHref}
        aria-label="Back"
        className="flex h-10 w-10 items-center justify-center rounded-2xl border border-black/5 bg-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-90 dark:border-line dark:bg-card"
      >
        <ArrowLeft className="h-[18px] w-[18px]" />
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-display text-lg font-bold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
        )}
      </div>
      {typeof balance === "number" && (
        <Link
          href="/wallet"
          className="hidden rounded-2xl bg-brand px-3 py-2 font-display text-xs font-bold text-ink transition-all hover:-translate-y-0.5 active:scale-95 sm:block"
        >
          {money(balance)}
        </Link>
      )}
      {right}
      <ThemeToggle />
    </header>
  );
}
