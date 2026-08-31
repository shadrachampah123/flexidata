import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Zap } from "lucide-react";
import { cn } from "@/lib/format";
import type { ReactNode } from "react";

export function BrandMark({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded-2xl bg-brand text-ink shadow-[0_8px_20px_rgba(255,203,5,0.35)]",
        size === "md" ? "h-11 w-11" : "h-9 w-9",
      )}
    >
      <Zap className={size === "md" ? "h-5 w-5" : "h-4 w-4"} strokeWidth={2.6} />
    </span>
  );
}

export function SectionTitle({
  title,
  action,
  href,
}: {
  title: string;
  action?: string;
  href?: string;
}) {
  return (
    <div className="mb-3 flex items-end justify-between">
      <h2 className="font-display text-[15px] font-bold tracking-tight">{title}</h2>
      {action && href && (
        <Link
          href={href}
          className="text-xs font-bold text-brand-deep transition-colors hover:text-[#18191f] dark:text-brand dark:hover:text-white"
        >
          {action}
        </Link>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { dot: string; text: string; pulse?: boolean }> = {
    successful: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
    pending: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", pulse: true },
    failed: { dot: "bg-rose-500", text: "text-rose-600 dark:text-rose-400" },
  };
  const s = map[status] ?? map.pending;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px] font-bold capitalize", s.text)}>
      <span className="relative flex h-1.5 w-1.5">
        {s.pulse && (
          <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-70", s.dot)} />
        )}
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", s.dot)} />
      </span>
      {status}
    </span>
  );
}

export function Segmented({
  options,
  value,
  onChange,
  className,
}: {
  options: { id: string; label: string; dot?: string }[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid auto-cols-fr grid-flow-col gap-1 rounded-2xl border border-black/5 bg-black/[0.04] p-1 dark:border-line dark:bg-white/[0.05]",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={cn(
              "flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-bold transition-all active:scale-95",
              active
                ? "bg-[#18191f] text-white shadow-md dark:bg-brand dark:text-ink"
                : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200",
            )}
          >
            {o.dot && (
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: o.dot }} />
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
      {children}
    </p>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  href,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: string;
  href?: string;
}) {
  return (
    <div className="flex flex-col items-center rounded-3xl border border-dashed border-black/10 px-6 py-10 text-center dark:border-line">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand/15 text-brand-deep dark:text-brand">
        <Icon className="h-5 w-5" />
      </span>
      <p className="font-display text-sm font-bold">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{body}</p>
      {action && href && (
        <Link
          href={href}
          className="mt-4 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-ink transition-transform hover:-translate-y-0.5 active:scale-95"
        >
          {action}
        </Link>
      )}
    </div>
  );
}

export function NetworkBadge({ network, className }: { network: string | null; className?: string }) {
  if (!network) return null;
  const mtn = network === "MTN";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-black tracking-wide",
        mtn ? "bg-brand/20 text-brand-deep dark:text-brand" : "bg-telecel/15 text-telecel",
        className,
      )}
    >
      <span className={cn("h-1 w-1 rounded-full", mtn ? "bg-brand-deep dark:bg-brand" : "bg-telecel")} />
      {network}
    </span>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[1.6rem] border border-black/[0.05] bg-paper shadow-[0_2px_12px_rgba(24,25,31,0.04)] dark:border-line dark:bg-card",
        className,
      )}
    >
      {children}
    </div>
  );
}
