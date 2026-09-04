import type { ReactNode } from "react";

/**
 * Admin page header.
 *
 * Titles are set by each page's own `metadata` export and deliberately avoid
 * the word "admin": the page only ever renders for an authorized administrator,
 * but keeping the title neutral means a metadata leak could never reveal that
 * the area exists (see the note in `src/app/admin/layout.tsx`).
 */
export function AdminPageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-[12px] leading-relaxed opacity-60">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
