import { requireAdmin } from "@/lib/admin/auth";
import { ATTENTION_SOURCE_LIMIT, loadAttention } from "@/lib/admin/queries-operations";
import { AdminPageHead } from "@/components/admin/page-head";
import { AttentionExplorer } from "@/components/admin/explorers";
import { Note, Panel } from "@/components/admin/ui";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";

/**
 * `/admin/attention` — the queue of orders that need a human.
 *
 * This is the screen that exists because of `src/lib/checkout.ts`: when the data
 * provider cannot be reached after payment, the order is parked as
 * `fulfillment_failed` with "Support will fulfil or refund this order" and is
 * NEVER auto-retried (a retry could deliver the bundle twice). Until now the
 * only way to see that queue was psql.
 *
 * Phase 1 exposes it. It does not work it: there is no fulfil, refund, resend or
 * retry action here or behind this screen.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Requires support · FlexiData" };

export default async function AdminAttentionPage({
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
    source: q(params, "source"),
  };

  const result = await loadAttention({
    source: (filters.source || null) as never,
    search: filters.search || undefined,
    page,
    pageSize,
  });

  return (
    <div className="space-y-4">
      <AdminPageHead
        title="Requires support"
        subtitle="Orders and deposits that need a human decision: paid but not delivered, parked by the provider-error guard, or a funding attempt that never settled."
      />

      <Panel
        title="What lands in this queue"
        bodyClassName="px-4 py-3"
      >
        <ul className="space-y-1.5 text-[12px] leading-relaxed opacity-75">
          <li>
            <strong className="font-semibold">Paystack orders</strong> — <code>fulfillment_failed</code>{" "}
            (payment taken, provider unreachable, never auto-retried), failed payments, and orders
            paid but unfulfilled for over two hours.
          </li>
          <li>
            <strong className="font-semibold">Wallet orders</strong> — wallet debited but never
            delivered, with no refund recorded.
          </li>
          <li>
            <strong className="font-semibold">Deposits</strong> — Paystack verification mismatches
            parked without crediting the wallet, and funding attempts left pending for over 24 hours.
          </li>
        </ul>
        <Note className="mt-3">
          Each source is capped at {ATTENTION_SOURCE_LIMIT} rows (oldest first) so this stays a work
          queue rather than a bulk export
          {result.capped ? " — at least one source is at that cap right now." : "."}
        </Note>
      </Panel>

      <AttentionExplorer
        initialRows={result.rows}
        initialTotal={result.total}
        initialPage={result.page}
        pageSize={result.pageSize}
        initialFilters={filters}
        counts={result.counts}
      />
    </div>
  );
}
