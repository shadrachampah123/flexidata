import { requireAdmin } from "@/lib/admin/auth";
import { loadNavBadges } from "@/lib/admin/queries";
import { AdminNav } from "@/components/admin/nav";
import { LogoutButton } from "@/components/logout-button";

/**
 * Admin area layout — the page-level half of the admin gate.
 *
 * `requireAdmin()` reads the session from the database, re-reads
 * `users.is_admin`, checks the `ADMIN_EMAILS` allowlist, and calls `notFound()`
 * for anyone who fails — so a non-admin gets an ordinary 404 and never learns
 * the admin area exists. Because the gate lives in the LAYOUT it runs before any
 * nested `/admin/*` page renders, so a future page inherits the protection
 * automatically instead of having to remember it.
 *
 * NOTE — deliberately no `metadata` export here. Next.js resolves a segment's
 * metadata independently of whether its component threw, so exporting
 * `title: "FlexiData Admin"` leaks the existence of the admin area into the
 * <title> of the 404 shown to non-admins. Without it the denied response is
 * indistinguishable from any other unknown URL, which is the whole point of
 * answering 404 instead of 403. Each page sets its own title instead — and only
 * ever renders for an authorized admin.
 *
 * `force-dynamic` is required: an authorization-dependent route must never be
 * statically rendered or cached.
 */
export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Denied requests never get past this line.
  const { admin } = await requireAdmin();

  // Cosmetic: a failure here must never take the dashboard down, so the badges
  // degrade to "unknown" rather than propagating.
  const badges = await loadNavBadges().catch(() => ({ support: null, stuck: null }));

  return (
    <div className="min-h-dvh bg-cream text-[#18191f] dark:bg-night dark:text-white">
      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/85 backdrop-blur-xl dark:border-line dark:bg-night/85">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-brand px-2 py-1 font-display text-[11px] font-bold uppercase tracking-wide text-ink">
              Admin
            </span>
            <span className="font-display text-sm font-bold">FlexiData Operations</span>
            <span className="hidden rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-400 sm:inline">
              Read-only
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden text-right text-[11px] leading-tight sm:block">
              <div className="font-semibold">{admin.name}</div>
              <div className="opacity-60">{admin.email}</div>
            </div>
            <LogoutButton full={false} />
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1400px] gap-0 md:gap-6">
        <aside className="hidden shrink-0 md:block md:w-56">
          <div className="sticky top-[57px] max-h-[calc(100dvh-57px)] overflow-y-auto py-4">
            <AdminNav badges={badges} />
            <p className="mt-4 px-4 text-[10px] leading-relaxed opacity-45">
              Phase 1 is an observation layer. Nothing on these screens can move money, change a
              balance or alter an order.
            </p>
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-3 py-4 pb-16 md:px-0 md:py-6">
          <div className="mb-3 md:hidden">
            <AdminNav badges={badges} />
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
