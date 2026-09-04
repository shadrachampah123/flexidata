import { requireAdmin } from "@/lib/admin/auth";

/**
 * Admin area layout — Phase 0.
 *
 * This layout is the page-level half of the admin gate. `requireAdmin()` reads
 * the session from the database, re-reads `users.is_admin`, checks the
 * `ADMIN_EMAILS` allowlist, and calls `notFound()` for anyone who fails — so a
 * non-admin gets an ordinary 404 and never learns the admin area exists.
 *
 * Because the gate lives in the LAYOUT, it runs before any nested `/admin/*`
 * page renders, and a future page added under `/admin` inherits the protection
 * automatically rather than having to remember it.
 *
 * NOTE — deliberately no `metadata` export here. Next.js resolves a segment's
 * metadata independently of whether its component threw, so exporting
 * `title: "FlexiData Admin"` leaked the existence of the admin area into the
 * <title> of the 404 page shown to non-admins. Without it the 404 is
 * byte-identical to any other unknown URL, which is the whole point of
 * answering 404 instead of 403. Search engines are not a concern: an anonymous
 * request to /admin is redirected to /login by the Edge gate and never sees
 * this segment at all.
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

  return (
    <div className="min-h-dvh bg-cream dark:bg-night">
      <header className="border-b border-black/5 bg-white/70 backdrop-blur-xl dark:border-line dark:bg-night/70">
        <div className="mx-auto flex w-full max-w-[900px] items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-brand px-2 py-1 font-display text-[11px] font-bold uppercase tracking-wide text-ink">
              Admin
            </span>
            <span className="font-display text-sm font-bold">FlexiData Operations</span>
          </div>
          <div className="text-right text-[11px] leading-tight opacity-70">
            <div className="font-medium">{admin.name}</div>
            <div>{admin.email}</div>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[900px] px-4 py-6">{children}</main>
    </div>
  );
}
