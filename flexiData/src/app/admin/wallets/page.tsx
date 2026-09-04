import { requireAdmin } from "@/lib/admin/auth";
import { loadWallets } from "@/lib/admin/queries";
import { AdminPageHead } from "@/components/admin/page-head";
import { WalletsExplorer } from "@/components/admin/explorers";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";

/**
 * `/admin/wallets` — wallet monitoring, READ-ONLY.
 *
 * Shows the stored (authoritative) balance beside a ledger-derived figure so an
 * operator can spot a discrepancy. There is deliberately no adjust, fix, edit or
 * set-balance control anywhere on this screen or behind it: the purpose at this
 * stage is diagnosis only.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Wallets · FlexiData" };

export default async function AdminWalletsPage({
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
    sort: q(params, "sort") || "difference",
    onlyMismatches: q(params, "onlyMismatches") === "1" ? "1" : "",
  };

  const result = await loadWallets({
    search: filters.search || undefined,
    sort: filters.sort || undefined,
    onlyMismatches: filters.onlyMismatches === "1",
    page,
    pageSize,
  });

  return (
    <div className="space-y-4">
      <AdminPageHead
        title="Wallets"
        subtitle="Stored balances and the ledger-derived figure they are compared against. Diagnosis only — no balance can be changed from the dashboard."
      />
      <WalletsExplorer
        initialRows={result.rows}
        initialTotal={result.total}
        initialPage={result.page}
        pageSize={result.pageSize}
        initialFilters={filters}
      />
    </div>
  );
}
