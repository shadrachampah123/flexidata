import { requireAdmin } from "@/lib/admin/auth";
import { loadRefundReviews } from "@/lib/admin/queries-investigation";
import { AdminPageHead } from "@/components/admin/page-head";
import { RefundReviewsExplorer } from "@/components/admin/investigation-explorers";
import { Note, Panel, StatTile } from "@/components/admin/ui";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";

/**
 * `/admin/reviews` — the refund-review backlog.
 *
 * Phase 2, Step 3 (S3.5). Step 2 let an administrator RECORD that finance should
 * look at refunding an order, and disclosed the gap that nothing listed those
 * records afterwards: a reviewed order simply stayed in the attention queue with
 * a note. This page is the worklist that was missing — every open review, its
 * age, and the total value waiting on a human decision.
 *
 * It is derived, not stored. A review is open when no delivery confirmation was
 * recorded at or after it, computed from `admin_audit_logs` joined to
 * `checkout_orders` inside a read-only transaction, so no status column was
 * invented and no order row was touched. This page has no controls at all: there
 * is nothing here to approve, close or pay, because this dashboard has no refund
 * execution path. Closing a review means resolving the order through the audited
 * support workflow, or finance settling it out-of-band.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Refund reviews · FlexiData" };

export default async function AdminRefundReviewsPage({
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
    state: q(params, "state"),
    sort: q(params, "sort"),
    dateFrom: q(params, "dateFrom"),
    dateTo: q(params, "dateTo"),
  };

  const result = await loadRefundReviews({
    search: filters.search || undefined,
    state: filters.state || null,
    sort: filters.sort || null,
    dateFrom: filters.dateFrom || null,
    dateTo: filters.dateTo || null,
    page,
    pageSize,
  });

  return (
    <div className="space-y-4">
      <AdminPageHead
        title="Refund reviews"
        subtitle="Orders an administrator has flagged for a refund decision, derived from the audit trail. No money moves here."
      />

      {!result.available ? (
        <Panel title="Not available on this database" bodyClassName="px-4 py-3">
          <Note>
            The refund-review backlog is derived from the administrator audit trail and the checkout
            order table. This deployment is missing one of them, so the backlog cannot be computed —
            and the support action that records a review refuses to run in the same situation.
          </Note>
        </Panel>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Open reviews"
              value={result.summary.open}
              severity={
                result.summary.open === null
                  ? "unknown"
                  : result.summary.open > 0
                    ? "attention"
                    : "healthy"
              }
              hint="Flagged for a refund decision and not yet resolved."
              href={result.summary.open && result.summary.open > 0 ? "/admin/reviews?state=open" : undefined}
            />
            <StatTile
              label="Value awaiting decision"
              value={result.summary.openValue}
              money
              severity={
                result.summary.openValue === null
                  ? "unknown"
                  : result.summary.openValue > 0
                    ? "attention"
                    : "healthy"
              }
              hint="Sum of the open reviews' order amounts. Not a liability figure — a decision backlog."
            />
            <StatTile
              label="Oldest open review"
              value={result.summary.oldestOpenHours === null ? null : `${result.summary.oldestOpenHours} h`}
              severity={
                result.summary.oldestOpenHours === null
                  ? "unknown"
                  : result.summary.oldestOpenHours > 72
                    ? "critical"
                    : result.summary.oldestOpenHours > 24
                      ? "attention"
                      : "healthy"
              }
              hint="How long a customer has been waiting on a decision."
            />
            <StatTile
              label="Closed reviews"
              value={result.summary.closed}
              hint="A delivery confirmation was recorded at or after the review."
            />
          </div>

          <RefundReviewsExplorer
            initialRows={result.rows}
            initialTotal={result.total}
            initialPage={result.page}
            pageSize={result.pageSize}
            initialFilters={filters}
          />
        </>
      )}
    </div>
  );
}
