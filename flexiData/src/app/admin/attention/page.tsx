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
 * NEVER auto-retried (a retry could deliver the bundle twice).
 *
 * Phase 1 made the queue visible. Phase 2, Step 2 lets it be worked — safely:
 * Paystack checkout orders may be marked delivered (only after the admin
 * explicitly confirms the customer received the data) or queued for refund
 * review (which records the review and nothing else). Both actions go through
 * the single gated `POST /api/admin/orders/[ref]/support` endpoint, are
 * audited in `admin_audit_logs`, and can never move money, touch a ledger row,
 * alter a payment, or retry a delivery. Wallet and deposit items in this queue
 * remain read-only diagnostics by design.
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
        title="What lands in this queue — and what you can do about it"
        bodyClassName="px-4 py-3"
      >
        <ul className="space-y-1.5 text-[12px] leading-relaxed opacity-75">
          <li>
            <strong className="font-semibold">Paystack orders</strong> — <code>fulfillment_failed</code>{" "}
            (payment taken, provider unreachable, never auto-retried), failed payments, and orders
            paid but unfulfilled for over two hours. These carry two support actions:{" "}
            <em>mark delivered</em> only when the customer&apos;s receipt of the data has been
            confirmed, and <em>refund review</em>, which records that finance should refund —
            it moves no money itself.
          </li>
          <li>
            <strong className="font-semibold">Wallet orders</strong> — wallet debited but never
            delivered, with no refund recorded. Read-only: they are ledger rows, and this
            dashboard never mutates the ledger, wallet balances or the provider callback flow
            that refunds them.
          </li>
          <li>
            <strong className="font-semibold">Deposits</strong> — Paystack verification mismatches
            parked without crediting the wallet, and funding attempts left pending for over 24 hours.
            Read-only: the funding flow settles them.
          </li>
        </ul>
        <Note className="mt-3">
          Each source is capped at {ATTENTION_SOURCE_LIMIT} rows (oldest first) so this stays a work
          queue rather than a bulk export
          {result.capped ? " — at least one source is at that cap right now." : "."}{" "}
          Every support action is explicitly confirmed, tied to the exact order reference and
          audited; nothing here can change a balance, a payment or a delivery.
          {result.actionsAvailable
            ? ""
            : " Support actions are currently unavailable because the support workflow schema is not applied on this database."}
        </Note>
      </Panel>

      <AttentionExplorer
        initialRows={result.rows}
        initialTotal={result.total}
        initialPage={result.page}
        pageSize={result.pageSize}
        initialFilters={filters}
        counts={result.counts}
        actionsAvailable={result.actionsAvailable}
      />
    </div>
  );
}
