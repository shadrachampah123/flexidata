import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/format";
import { adminMoney, adminMoneyDelta } from "@/lib/admin/format";
import type { AdminSeverity } from "@/lib/admin/types";

/**
 * Presentational building blocks for the admin dashboard.
 *
 * No hooks, no data access and no `"use client"` directive: these are plain
 * components so they can be rendered by a Server Component page and reused by
 * the client-side explorers without dragging the query layer into the browser
 * bundle.
 *
 * The visual language deliberately matches the customer app (same radii, same
 * brand yellow, same display font) so the admin area feels like part of
 * FlexiData rather than a bolted-on console.
 */

/** 🟢 Healthy · 🟡 Attention · 🔴 Critical · ⚪ Not available. */
export const SEVERITY_STYLES: Record<AdminSeverity, { dot: string; text: string; label: string }> = {
  healthy: { dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400", label: "Healthy" },
  attention: { dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400", label: "Attention" },
  critical: { dot: "bg-rose-500", text: "text-rose-700 dark:text-rose-400", label: "Critical" },
  unknown: { dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400", label: "Not available" },
};

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-black/[0.06] bg-paper shadow-[0_1px_10px_rgba(24,25,31,0.04)] dark:border-line dark:bg-card",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-black/[0.05] px-4 py-3 dark:border-line">
          <div>
            {title && <h2 className="font-display text-[13px] font-bold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[11px] leading-relaxed opacity-60">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("px-4 py-3", bodyClassName)}>{children}</div>
    </section>
  );
}

export function SeverityDot({ severity, className }: { severity: AdminSeverity; className?: string }) {
  const style = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.unknown;
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", style.dot, className)}
    />
  );
}

export function StatusPill({
  severity,
  children,
  className,
}: {
  severity: AdminSeverity;
  children: ReactNode;
  className?: string;
}) {
  const style = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.unknown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-black/[0.02] px-2 py-0.5 text-[11px] font-semibold dark:border-line dark:bg-white/[0.04]",
        style.text,
        className,
      )}
    >
      <SeverityDot severity={severity} />
      {children}
    </span>
  );
}

/** Big number tile. `null` renders an explicit "Not available" state. */
export function StatTile({
  label,
  value,
  hint,
  severity = "unknown",
  href,
  money = false,
}: {
  label: string;
  value: number | string | null;
  hint?: string;
  severity?: AdminSeverity;
  href?: string;
  money?: boolean;
}) {
  const missing = value === null || value === undefined;
  const style = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.unknown;
  const body = (
    <>
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
        {label}
      </p>
      <p
        className={cn(
          "mt-1.5 font-display text-xl font-bold leading-none tracking-tight tabular-nums",
          missing && "text-base font-semibold opacity-45",
        )}
      >
        {missing
          ? "Not available"
          : money
            ? adminMoney(typeof value === "number" ? value : Number(value))
            : typeof value === "number"
              ? value.toLocaleString("en-GH")
              : value}
      </p>
      {hint && <p className="mt-1.5 text-[11px] leading-snug opacity-55">{hint}</p>}
    </>
  );

  const shell = cn(
    "block rounded-2xl border border-black/[0.06] bg-paper px-4 py-3 shadow-[0_1px_10px_rgba(24,25,31,0.04)] transition-shadow dark:border-line dark:bg-card",
    !missing && severity !== "unknown" && "border-l-[3px]",
    !missing && severity === "critical" && "border-l-rose-500",
    !missing && severity === "attention" && "border-l-amber-500",
    !missing && severity === "healthy" && "border-l-emerald-500",
  );

  if (href) {
    return (
      <Link href={href} className={cn(shell, "hover:shadow-[0_2px_16px_rgba(24,25,31,0.08)]")}>
        {body}
      </Link>
    );
  }
  return <div className={shell}>{body}</div>;
}

export function MoneyCell({
  amount,
  className,
  muted,
}: {
  amount: number | null;
  className?: string;
  muted?: boolean;
}) {
  if (amount === null) return <span className="text-[11px] opacity-45">Not available</span>;
  return (
    <span
      className={cn(
        "whitespace-nowrap font-semibold tabular-nums",
        muted ? "opacity-50" : "",
        className,
      )}
    >
      {adminMoney(amount)}
    </span>
  );
}

export function MoneyDelta({ amount, className }: { amount: number | null; className?: string }) {
  if (amount === null) return <span className="text-[11px] opacity-45">Not available</span>;
  if (amount === 0) {
    return <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{adminMoney(0)}</span>;
  }
  return (
    <span className={cn("font-semibold tabular-nums text-rose-600 dark:text-rose-400", className)}>
      {adminMoneyDelta(amount)}
    </span>
  );
}

export function KeyValues({
  items,
  className,
}: {
  items: { label: string; value: ReactNode; mono?: boolean }[];
  className?: string;
}) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-2 sm:grid-cols-2", className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
            {item.label}
          </dt>
          <dd
            className={cn(
              "mt-0.5 break-words text-[13px]",
              item.mono && "font-mono text-[12px]",
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "mono";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        tone === "neutral" && "bg-black/[0.05] text-zinc-600 dark:bg-white/[0.07] dark:text-zinc-300",
        tone === "brand" && "bg-brand/20 text-brand-deep dark:text-brand",
        tone === "mono" && "bg-black/[0.05] font-mono normal-case tracking-normal dark:bg-white/[0.07]",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyRow({ label, colSpan }: { label: string; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-[13px] opacity-55">
        {label}
      </td>
    </tr>
  );
}

/** Small note under a table or panel — used for caveats and definitions. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-[11px] leading-relaxed opacity-55", className)}>{children}</p>
  );
}
