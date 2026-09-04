import { requireAdmin } from "@/lib/admin/auth";
import { loadTransactions } from "@/lib/admin/queries-operations";
import { AdminPageHead } from "@/components/admin/page-head";
import { TransactionsExplorer } from "@/components/admin/explorers";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";

/**
 * `/admin/transactions` — the transaction explorer.
 *
 * Server-side filtering and pagination: the browser never receives the whole
 * ledger, and every filter is applied in SQL with bound parameters. No
 * transaction action exists — the screen cannot edit, retry, refund or reverse
 * anything.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Transactions · FlexiData" };

export default async function AdminTransactionsPage({
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
    type: q(params, "type"),
    status: q(params, "status"),
    direction: q(params, "direction"),
    provider: q(params, "provider"),
    dateFrom: q(params, "dateFrom"),
    dateTo: q(params, "dateTo"),
    amountMin: q(params, "amountMin"),
    amountMax: q(params, "amountMax"),
  };

  const result = await loadTransactions({
    search: filters.search || undefined,
    type: filters.type || null,
    status: filters.status || null,
    direction: filters.direction || null,
    provider: filters.provider || null,
    dateFrom: filters.dateFrom || null,
    dateTo: filters.dateTo || null,
    amountMin: filters.amountMin ? Number(filters.amountMin) : null,
    amountMax: filters.amountMax ? Number(filters.amountMax) : null,
    page,
    pageSize,
  });

  return (
    <div className="space-y-4">
      <AdminPageHead
        title="Transactions"
        subtitle="Every ledger row, searchable by reference, customer, wallet, type, direction, status, provider, date and amount. Read-only."
      />
      <TransactionsExplorer
        initialRows={result.rows}
        initialTotal={result.total}
        initialPage={result.page}
        pageSize={result.pageSize}
        initialFilters={filters}
        providers={result.providers}
      />
    </div>
  );
}
