"use client";

import Link from "next/link";
import { AdminExplorer, type AdminColumn, type AdminFilterField } from "@/components/admin/explorer";
import { Badge, MoneyCell, Note, StatusPill } from "@/components/admin/ui";
import { formatDateTime } from "@/lib/admin/format";
import type { AdminAuditRow, AdminRefundReviewRow } from "@/lib/admin/types";

/**
 * Phase 2, Step 3 — list views for the accountability surfaces.
 *
 * Both are the standard admin explorer: the server renders page 1 through the
 * read-only query layer, the browser then pages and filters through the matching
 * `/api/admin/*` endpoint, and every one of those re-runs the Phase 0 gate before
 * answering.
 *
 * Neither issues anything but a GET. There is no action column, no button that
 * changes a record and no way to reach the Step 2 support workflow from here
 * except by following a link to the order it concerns — the admin browser write
 * surface stays exactly the two confirmation modals the Phase 1/2 harnesses
 * allowlist.
 */

// ---------------------------------------------------------------------------
// Shared cells
// ---------------------------------------------------------------------------

function MonoLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-mono text-[12px] font-semibold text-brand-deep hover:underline dark:text-brand">
      {children}
    </Link>
  );
}

function TwoLine({ primary, secondary }: { primary: React.ReactNode; secondary?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate">{primary}</div>
      {secondary && <div className="mt-0.5 truncate text-[11px] opacity-55">{secondary}</div>}
    </div>
  );
}

function ageLabel(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return "under 1 h";
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

// ---------------------------------------------------------------------------
// Admin activity log
// ---------------------------------------------------------------------------

export function AuditExplorer({
  initialRows,
  initialTotal,
  initialPage,
  pageSize,
  initialFilters,
  adminOptions,
  actionOptions,
  refTrailAvailable,
}: {
  initialRows: AdminAuditRow[];
  initialTotal: number;
  initialPage: number;
  pageSize: number;
  initialFilters: Record<string, string>;
  adminOptions: { id: number; name: string }[];
  actionOptions: { value: string; label: string }[];
  refTrailAvailable: boolean;
}) {
  const filters: AdminFilterField[] = [
    {
      name: "search",
      label: "Search",
      type: "text",
      placeholder: refTrailAvailable ? "Reference, reason, admin or customer" : "Reason, admin or customer",
    },
    {
      name: "action",
      label: "Action",
      type: "select",
      options: actionOptions,
    },
    {
      name: "admin",
      label: "Administrator",
      type: "select",
      options: adminOptions.map((option) => ({ value: String(option.id), label: option.name })),
    },
    { name: "userId", label: "Customer id", type: "number" },
    { name: "dateFrom", label: "From", type: "date" },
    { name: "dateTo", label: "To", type: "date" },
  ];

  const columns: AdminColumn<AdminAuditRow>[] = [
    {
      key: "createdAt",
      header: "When",
      cell: (row) => <span className="whitespace-nowrap text-[12px]">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: "action",
      header: "Action",
      cell: (row) => (
        <TwoLine
          primary={<span className="font-semibold">{row.actionLabel}</span>}
          secondary={row.targetKind === "order" ? "order-level" : "account-level"}
        />
      ),
    },
    {
      key: "admin",
      header: "Administrator",
      cell: (row) => (
        <TwoLine
          primary={
            <Link href={`/admin/users/${row.adminUserId}`} className="font-semibold hover:underline">
              {row.adminName ?? `#${row.adminUserId}`}
            </Link>
          }
          secondary={row.adminEmail}
        />
      ),
    },
    {
      key: "target",
      header: "Customer",
      cell: (row) => (
        <TwoLine
          primary={
            <Link href={`/admin/users/${row.targetUserId}`} className="hover:underline">
              {row.targetName ?? `#${row.targetUserId}`}
            </Link>
          }
          secondary={row.targetEmail}
        />
      ),
    },
    {
      key: "ref",
      header: "Reference",
      cell: (row) =>
        row.targetRef ? (
          <MonoLink href={`/admin/orders/${encodeURIComponent(row.targetRef)}`}>{row.targetRef}</MonoLink>
        ) : (
          <span className="text-[11px] opacity-45">—</span>
        ),
    },
    {
      key: "reason",
      header: "Reason",
      cell: (row) =>
        row.reason ? (
          <span className="text-[12px] opacity-75">{row.reason}</span>
        ) : (
          <span className="text-[11px] opacity-45">Not given</span>
        ),
    },
  ];

  return (
    <AdminExplorer<AdminAuditRow>
      endpoint="/api/admin/audit"
      columns={columns}
      filters={filters}
      initialFilters={initialFilters}
      initialRows={initialRows}
      initialTotal={initialTotal}
      initialPage={initialPage}
      pageSize={pageSize}
      emptyLabel="No administrator activity matches this view."
      rowKey={(row) => String(row.id)}
      note={
        <Note>
          Append-only: rows are written by the gated suspend / activate and order-support endpoints
          and are never edited or deleted by this dashboard. Reading this page adds nothing to it.
          {!refTrailAvailable &&
            " This database predates the order-reference column, so references are not shown."}
        </Note>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Refund-review backlog
// ---------------------------------------------------------------------------

export function RefundReviewsExplorer({
  initialRows,
  initialTotal,
  initialPage,
  pageSize,
  initialFilters,
}: {
  initialRows: AdminRefundReviewRow[];
  initialTotal: number;
  initialPage: number;
  pageSize: number;
  initialFilters: Record<string, string>;
}) {
  const filters: AdminFilterField[] = [
    { name: "search", label: "Search", type: "text", placeholder: "Reference, customer or bundle" },
    {
      name: "state",
      label: "State",
      type: "select",
      options: [
        { value: "open", label: "Open" },
        { value: "closed", label: "Closed" },
      ],
    },
    {
      name: "sort",
      label: "Sort",
      type: "select",
      options: [
        { value: "oldest", label: "Open first, oldest" },
        { value: "recent", label: "Most recently reviewed" },
        { value: "amount", label: "Open first, largest" },
      ],
    },
    { name: "dateFrom", label: "Reviewed from", type: "date" },
    { name: "dateTo", label: "Reviewed to", type: "date" },
  ];

  const columns: AdminColumn<AdminRefundReviewRow>[] = [
    {
      key: "state",
      header: "State",
      cell: (row) => (
        <StatusPill severity={row.state === "open" ? "attention" : "healthy"}>
          {row.state === "open" ? "Open review" : "Closed"}
        </StatusPill>
      ),
    },
    {
      key: "ref",
      header: "Order",
      cell: (row) => <MonoLink href={`/admin/orders/${encodeURIComponent(row.ref)}`}>{row.ref}</MonoLink>,
    },
    {
      key: "customer",
      header: "Customer",
      cell: (row) => (
        <TwoLine
          primary={
            row.userId ? (
              <Link href={`/admin/users/${row.userId}`} className="font-semibold hover:underline">
                {row.customerName ?? `#${row.userId}`}
              </Link>
            ) : (
              <span className="font-semibold">{row.customerName ?? "Unknown"}</span>
            )
          }
          secondary={`${row.customerEmail} · ${row.phone}`}
        />
      ),
    },
    {
      key: "bundle",
      header: "Bundle",
      cell: (row) => (
        <TwoLine
          primary={row.bundle}
          secondary={row.network ? `${row.network} · order ${row.orderStatus ?? "unknown"}` : `order ${row.orderStatus ?? "unknown"}`}
        />
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      cell: (row) => <MoneyCell amount={row.amount} />,
    },
    {
      key: "age",
      header: "Review age",
      align: "right",
      cell: (row) => (
        <span className="whitespace-nowrap text-[12px] tabular-nums">
          {row.state === "open" ? ageLabel(row.ageHours) : `closed ${formatDateTime(row.resolvedAt)}`}
        </span>
      ),
    },
    {
      key: "review",
      header: "Recorded by",
      cell: (row) => (
        <TwoLine
          primary={row.reviewedBy ?? "Unknown administrator"}
          secondary={
            row.reason ? `“${row.reason}” · ${formatDateTime(row.firstReviewAt)}` : formatDateTime(row.firstReviewAt)
          }
        />
      ),
    },
  ];

  return (
    <AdminExplorer<AdminRefundReviewRow>
      endpoint="/api/admin/reviews"
      columns={columns}
      filters={filters}
      initialFilters={initialFilters}
      initialRows={initialRows}
      initialTotal={initialTotal}
      initialPage={initialPage}
      pageSize={pageSize}
      emptyLabel="No refund reviews have been recorded."
      rowKey={(row) => row.ref}
      note={
        <Note>
          Derived entirely from the audit trail — a review is <Badge tone="mono">open</Badge> until a
          delivery confirmation is recorded at or after it. Nothing here moves money: recording a
          review writes one audit row and leaves the order byte-identical, and closing one means an
          administrator resolving the order through the support workflow or finance settling it
          out-of-band.
        </Note>
      }
    />
  );
}
