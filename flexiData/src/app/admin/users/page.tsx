import { requireAdmin } from "@/lib/admin/auth";
import { loadUsers } from "@/lib/admin/queries";
import { AdminPageHead } from "@/components/admin/page-head";
import { UsersExplorer } from "@/components/admin/explorers";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";

/**
 * `/admin/users` — customer search, read-only.
 *
 * Search runs server-side against the real values, but the list only ever
 * renders masked emails and phone numbers. Accounts cannot be created, edited,
 * suspended, promoted or password-reset from here.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Customers · FlexiData" };

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const page = parsePage(q(params, "page"));
  const pageSize = parsePageSize(q(params, "pageSize"));
  const filters = {
    search: q(params, "search"),
    sort: q(params, "sort"),
  };

  const result = await loadUsers({
    search: filters.search || undefined,
    sort: filters.sort || undefined,
    page,
    pageSize,
  });

  return (
    <div className="space-y-4">
      <AdminPageHead
        title="Customers"
        subtitle="Search by name, email, phone or referral code. Opening a customer shows their wallet, recent activity and account status."
      />

      <UsersExplorer
        initialRows={result.rows}
        initialTotal={result.total}
        initialPage={result.page}
        pageSize={result.pageSize}
        initialFilters={filters}
      />
    </div>
  );
}
