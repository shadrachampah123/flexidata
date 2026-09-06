import { requireAdmin } from "@/lib/admin/auth";
import { loadAdminAudit } from "@/lib/admin/queries-investigation";
import { AdminPageHead } from "@/components/admin/page-head";
import { AuditExplorer } from "@/components/admin/investigation-explorers";
import { Note, Panel, StatTile } from "@/components/admin/ui";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";

/**
 * `/admin/audit` — the administrator activity trail.
 *
 * Phase 2, Step 3 (S3.4). Steps 1 and 2 made every state-changing admin action
 * write a row to `admin_audit_logs`; this page is the first place anyone can read
 * that trail back without a SQL client. It answers "who did what, to whom, on
 * which order, when, and what reason did they give".
 *
 * Read-only and additively so: the trail is append-only in the sense that
 * nothing in this dashboard ever updates or deletes a row, and reading it here
 * writes nothing at all — the Step 3 harness asserts the row count is unchanged
 * after a full sweep of this page and its API.
 *
 * List view, so contact details are masked (the established convention). It
 * degrades rather than fails on a database that predates the audit trail.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Activity · FlexiData" };

export default async function AdminAuditPage({
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
    action: q(params, "action"),
    admin: q(params, "admin"),
    userId: q(params, "userId"),
    dateFrom: q(params, "dateFrom"),
    dateTo: q(params, "dateTo"),
  };

  const result = await loadAdminAudit({
    search: filters.search || undefined,
    action: filters.action || null,
    admin: filters.admin ? Number(filters.admin) : null,
    userId: filters.userId ? Number(filters.userId) : null,
    dateFrom: filters.dateFrom || null,
    dateTo: filters.dateTo || null,
    page,
    pageSize,
  });

  return (
    <div className="space-y-4">
      <AdminPageHead
        title="Administrator activity"
        subtitle="Every action an administrator has recorded: customer suspensions and activations, confirmed deliveries and refund reviews."
      />

      {!result.available ? (
        <Panel title="Not available on this database" bodyClassName="px-4 py-3">
          <Note>
            This deployment does not have the <code>admin_audit_logs</code> table, so there is no
            administrator activity trail to read. The gated suspend / activate and order-support
            actions refuse to run without it, so nothing has been recorded and nothing can be changed
            until the pending migrations are applied.
          </Note>
        </Panel>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Recorded actions"
              value={result.summary.all}
              severity={result.summary.all && result.summary.all > 0 ? "healthy" : "unknown"}
              hint="Every row ever written to the trail."
            />
            <StatTile
              label="In this view"
              value={result.summary.inRange}
              hint="After the current filters."
            />
            <StatTile
              label="Administrators"
              value={result.summary.admins}
              hint="Distinct acting admins in this view."
            />
            <StatTile
              label="Order references"
              value={result.refTrailAvailable ? null : 0}
              severity={result.refTrailAvailable ? "healthy" : "attention"}
              hint={
                result.refTrailAvailable
                  ? "Order-level actions carry the reference they acted on."
                  : "This database predates the order-reference column."
              }
            />
          </div>

          {result.summary.byAction.length > 0 && (
            <Panel title="Breakdown in this view" bodyClassName="px-4 py-3">
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {result.summary.byAction.map((entry) => (
                  <li key={entry.action} className="rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
                    <p className="text-[11px] font-semibold opacity-70">{entry.label}</p>
                    <p className="font-display text-lg font-bold tabular-nums">
                      {entry.count.toLocaleString("en-GH")}
                    </p>
                    <p className="font-mono text-[10px] opacity-45">{entry.action}</p>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <AuditExplorer
            initialRows={result.rows}
            initialTotal={result.total}
            initialPage={result.page}
            pageSize={result.pageSize}
            initialFilters={filters}
            adminOptions={result.adminOptions}
            actionOptions={result.actionOptions}
            refTrailAvailable={result.refTrailAvailable}
          />
        </>
      )}
    </div>
  );
}
