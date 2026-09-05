import { requireAdmin } from "@/lib/admin/auth";
import { loadPayments } from "@/lib/admin/queries-operations";
import { AdminPageHead } from "@/components/admin/page-head";
import { PaymentsExplorer } from "@/components/admin/explorers";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";

/**
 * `/admin/payments` — deposit and Paystack activity, read-only.
 *
 * No Paystack API is called, nothing is re-verified, retried or refunded. The
 * "wallet credit" column is derived by looking for the matching ledger row, so an
 * operator can see a payment that was taken but never credited without opening a
 * SQL client.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Payments · FlexiData" };

export default async function AdminPaymentsPage({
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
    status: q(params, "status"),
    provider: q(params, "provider"),
    channel: q(params, "channel"),
    credit: q(params, "credit"),
    dateFrom: q(params, "dateFrom"),
    dateTo: q(params, "dateTo"),
    amountMin: q(params, "amountMin"),
    amountMax: q(params, "amountMax"),
  };

  const result = await loadPayments({
    search: filters.search || undefined,
    status: filters.status || null,
    provider: filters.provider || null,
    channel: filters.channel || null,
    credit: filters.credit || null,
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
        title="Payments &amp; deposits"
        subtitle="Wallet funding attempts with their provider, channel, gateway response and whether the matching wallet credit exists. Read-only."
      />

      <PaymentsExplorer
        initialRows={result.rows}
        initialTotal={result.total}
        initialPage={result.page}
        pageSize={result.pageSize}
        initialFilters={filters}
        providers={result.providers}
        channels={result.channels}
        summary={result.summary}
      />
    </div>
  );
}
