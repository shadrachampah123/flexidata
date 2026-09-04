import { requireAdmin } from "@/lib/admin/auth";

/**
 * Admin index — Phase 0 status stub.
 *
 * This is NOT the Admin Dashboard. Phase 0 delivers the access-control gate
 * only; there is deliberately no data here, no query over users, wallets,
 * deposits, orders or the ledger, and no action of any kind. The page exists so
 * that the gate has something to protect and so the guarantee can be observed
 * end to end.
 *
 * The layout has already authorized this request; calling `requireAdmin()`
 * again is intentional belt-and-braces — a page must never assume its layout
 * ran the check.
 */
export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const { admin } = await requireAdmin();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl font-bold">Access gate active</h1>
        <p className="mt-1 text-sm opacity-70">
          Phase 0 is complete: administrative authorization is enforced server-side and is
          revocable. No dashboard, reporting or financial functionality exists yet.
        </p>
      </div>

      <div className="rounded-2xl border border-black/5 bg-white/70 p-4 text-sm dark:border-line dark:bg-white/[0.03]">
        <h2 className="font-display text-sm font-bold">Authorized as</h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <dt className="opacity-60">Name</dt>
          <dd>{admin.name}</dd>
          <dt className="opacity-60">Email</dt>
          <dd>{admin.email}</dd>
          <dt className="opacity-60">User ID</dt>
          <dd>{admin.userId}</dd>
          <dt className="opacity-60">Session</dt>
          <dd>{admin.sessionId === null ? "test seam (non-production)" : `#${admin.sessionId}`}</dd>
        </dl>
      </div>

      <div className="rounded-2xl border border-black/5 bg-white/70 p-4 text-sm dark:border-line dark:bg-white/[0.03]">
        <h2 className="font-display text-sm font-bold">How access is granted</h2>
        <p className="mt-2 text-[13px] leading-relaxed opacity-75">
          Two independent signals are required, and both are checked on every request:
          <code className="mx-1 rounded bg-black/[0.06] px-1 py-0.5 text-[12px] dark:bg-white/10">
            users.is_admin
          </code>
          must be true in the database, and the account&rsquo;s email must appear in the
          <code className="mx-1 rounded bg-black/[0.06] px-1 py-0.5 text-[12px] dark:bg-white/10">
            ADMIN_EMAILS
          </code>
          environment allowlist. Clearing either one revokes access immediately &mdash; no sign-out
          required. Grant and revoke with{" "}
          <code className="rounded bg-black/[0.06] px-1 py-0.5 text-[12px] dark:bg-white/10">
            npm run admin:grant
          </code>
          .
        </p>
      </div>

      <p className="text-[12px] opacity-55">
        Phase 1 (a read-only dashboard) has not been implemented and requires explicit approval.
      </p>
    </div>
  );
}
