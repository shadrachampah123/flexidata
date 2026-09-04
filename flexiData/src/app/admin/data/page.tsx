import Link from "next/link";
import { requireAdmin } from "@/lib/admin/auth";
import { loadDataOrders } from "@/lib/admin/queries-operations";
import { AdminPageHead } from "@/components/admin/page-head";
import { BucketStrip, DataOrdersExplorer } from "@/components/admin/explorers";
import { Note } from "@/components/admin/ui";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";

/**
 * `/admin/data` — data purchase and delivery operations.
 *
 * Two channels, because FlexiData genuinely has two purchase pipelines:
 *
 *  - `wallet`   — wallet-funded purchases (`transactions`, debited before the
 *                 bundle is submitted)
 *  - `checkout` — Paystack pay-as-you-go orders (`checkout_orders`, the wallet
 *                 is never touched)
 *
 * Both are read-only. Nothing here retries a delivery, resends a bundle,
 * refunds an order or changes a status.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Data operations · FlexiData" };

export default async function AdminDataPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const channel = q(params, "channel") === "checkout" ? "checkout" : "wallet";
  const page = parsePage(q(params, "page"));
  const pageSize = parsePageSize(q(params, "pageSize"));
  const filters = {
    search: q(params, "search"),
    bucket: q(params, "bucket"),
    network: q(params, "network"),
    dateFrom: q(params, "dateFrom"),
    dateTo: q(params, "dateTo"),
  };

  const result = await loadDataOrders({
    channel,
    search: filters.search || undefined,
    bucket: (filters.bucket || null) as never,
    network: filters.network || null,
    dateFrom: filters.dateFrom || null,
    dateTo: filters.dateTo || null,
    page,
    pageSize,
  });

  return (
    <div className="space-y-4">
      <AdminPageHead
        title="Data operations"
        subtitle="Every data and airtime order with its payment, wallet-debit and delivery state. Read-only — no retry, resend or refund."
        actions={
          <div className="flex items-center gap-1 rounded-xl border border-black/[0.08] p-1 text-[12px] font-semibold dark:border-line">
            <Link
              href="/admin/data?channel=wallet"
              className={`rounded-lg px-3 py-1.5 ${
                channel === "wallet" ? "bg-brand text-ink" : "opacity-65 hover:opacity-100"
              }`}
            >
              Wallet-funded
            </Link>
            <Link
              href="/admin/data?channel=checkout"
              className={`rounded-lg px-3 py-1.5 ${
                channel === "checkout" ? "bg-brand text-ink" : "opacity-65 hover:opacity-100"
              }`}
            >
              Paystack checkout
            </Link>
          </div>
        }
      />

      <BucketStrip buckets={result.buckets} channel={channel} />

      <DataOrdersExplorer
        channel={channel}
        initialRows={result.rows}
        initialTotal={result.total}
        initialPage={result.page}
        pageSize={result.pageSize}
        initialFilters={filters}
      />

      <Note>
        Phone numbers are masked in list views and shown in full only on a deliberately opened
        customer or transaction page. “Requires support” counts paid orders that failed after
        payment — see the support queue for the human-readable list.
      </Note>
    </div>
  );
}
