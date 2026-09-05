import { requireAdmin } from "@/lib/admin/auth";
import { loadReconciliation } from "@/lib/admin/queries";
import { AdminPageHead } from "@/components/admin/page-head";
import { ReconciliationExplorer } from "@/components/admin/explorers";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";

/**
 * `/admin/reconciliation` — stored balance vs ledger-derived balance.
 *
 * A diagnostic tool, not a correction tool. The stored wallet balance remains
 * the source of truth; the calculated figure exists only to be compared with it.
 * There is no fix, adjust or set-balance action anywhere in Phase 1.
 *
 * When a wallet mismatches, the wallet detail screen lists the transactions that
 * contributed to the calculation — as evidence of what was summed, never as a
 * claim about which row caused the difference.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Reconciliation · FlexiData" };

export default async function AdminReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const page = parsePage(q(params, "page"));
  const pageSize = parsePageSize(q(params, "pageSize"));
  const onlyMismatches = q(params, "only") === "mismatches" || q(params, "onlyMismatches") === "1";
  const filters = {
    search: q(params, "search"),
    onlyMismatches: onlyMismatches ? "1" : "",
  };

  const result = await loadReconciliation({
    search: filters.search || undefined,
    onlyMismatches,
    page,
    pageSize,
  });

  return (
    <div className="space-y-4">
      <AdminPageHead
        title="Reconciliation"
        subtitle="Compares the stored wallet balance with the balance that can be derived from the existing transaction records. Read-only diagnosis."
      />

      <ReconciliationExplorer
        initialRows={result.rows}
        initialTotal={result.total}
        initialPage={result.page}
        pageSize={result.pageSize}
        initialFilters={filters}
        rule={result.rule}
        mismatches={result.mismatches}
        walletsExamined={result.walletsExamined}
      />
    </div>
  );
}
