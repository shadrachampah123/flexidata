"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AdminExplorer, type AdminColumn, type AdminFilterField } from "@/components/admin/explorer";
import { Badge, MoneyCell, MoneyDelta, Note, Panel, SeverityDot, StatusPill } from "@/components/admin/ui";
import { adminMoney, formatDate, formatDateTime } from "@/lib/admin/format";
import type { DataChannel } from "@/lib/admin/queries-operations";
import type {
  AdminAttentionRow,
  AdminDataOrderRow,
  AdminPaymentRow,
  AdminReconciliationRow,
  AdminSeverity,
  AdminTransactionRow,
  AdminUserRow,
  AdminWalletRow,
} from "@/lib/admin/types";

/**
 * Column definitions for each admin list.
 *
 * These are client components: the tables re-render in the browser when an
 * operator pages or filters, using the JSON returned by the matching
 * `/api/admin/*` endpoint. Only display logic lives here — no data access, no
 * authorization decisions and, critically, no action of any kind.
 */

// ---------------------------------------------------------------------------
// Shared cells
// ---------------------------------------------------------------------------

function MonoLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="font-mono text-[12px] font-semibold text-brand-deep hover:underline dark:text-brand"
    >
      {children}
    </Link>
  );
}

function TwoLine({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate">{primary}</div>
      {secondary && <div className="truncate text-[11px] opacity-55">{secondary}</div>}
    </div>
  );
}

function TimeCell({ value }: { value: string | null }) {
  return <span className="whitespace-nowrap text-[12px] tabular-nums opacity-70">{formatDateTime(value)}</span>;
}

const TX_STATUS_SEVERITY: Record<string, AdminSeverity> = {
  successful: "healthy",
  pending: "attention",
  failed: "critical",
  reversed: "unknown",
};

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

const WALLET_FILTERS: AdminFilterField[] = [
  { name: "search", label: "Search", type: "text", placeholder: "Name, email, phone or wallet" },
  {
    name: "sort",
    label: "Sort by",
    type: "select",
    options: [
      { value: "difference", label: "Largest difference" },
      { value: "balance", label: "Largest balance" },
      { value: "recent", label: "Newest wallet" },
      { value: "id", label: "Wallet ID" },
    ],
  },
  {
    name: "onlyMismatches",
    label: "Balances",
    type: "select",
    options: [{ value: "1", label: "Mismatches only" }],
  },
];

export function WalletsExplorer({
  initialRows,
  initialTotal,
  initialPage,
  pageSize,
  initialFilters,
}: {
  initialRows: AdminWalletRow[];
  initialTotal: number;
  initialPage: number;
  pageSize: number;
  initialFilters: Record<string, string>;
}) {
  const columns: AdminColumn<AdminWalletRow>[] = [
    {
      key: "wallet",
      header: "Wallet",
      cell: (row) => (
        <TwoLine
          primary={<MonoLink href={`/admin/wallets/${row.walletId}`}>#{row.walletId}</MonoLink>}
          secondary={row.walletNumber}
        />
      ),
    },
    {
      key: "customer",
      header: "Customer",
      cell: (row) => (
        <TwoLine
          primary={
            row.userId ? (
              <Link href={`/admin/users/${row.userId}`} className="hover:underline">
                {row.userName ?? "Unlinked wallet"}
              </Link>
            ) : (
              <span className="opacity-60">No linked user</span>
            )
          }
          secondary={row.userEmail}
        />
      ),
    },
    {
      key: "stored",
      header: "Stored balance",
      align: "right",
      cell: (row) => <MoneyCell amount={row.storedBalance} />,
    },
    {
      key: "calculated",
      header: "Calculated balance",
      align: "right",
      cell: (row) => <MoneyCell amount={row.calculatedBalance} muted />,
    },
    {
      key: "difference",
      header: "Difference",
      align: "right",
      cell: (row) => <MoneyDelta amount={row.difference} />,
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <StatusPill severity={row.diffStatus === "matched" ? "healthy" : row.diffStatus === "mismatch" ? "critical" : "unknown"}>
          {row.diffStatus === "matched"
            ? "Matched"
            : row.diffStatus === "mismatch"
              ? "Mismatch"
              : "Not available"}
        </StatusPill>
      ),
    },
    {
      key: "examined",
      header: "Ledger rows",
      align: "right",
      cell: (row) => <span className="tabular-nums opacity-70">{row.transactionsExamined ?? "—"}</span>,
    },
    {
      key: "last",
      header: "Last movement",
      cell: (row) => <TimeCell value={row.lastTransactionAt} />,
    },
  ];

  return (
    <AdminExplorer
      endpoint="/api/admin/wallets"
      columns={columns}
      filters={WALLET_FILTERS}
      initialFilters={initialFilters}
      initialRows={initialRows}
      initialTotal={initialTotal}
      initialPage={initialPage}
      pageSize={pageSize}
      rowKey={(row) => `wallet-${row.walletId}`}
      emptyLabel="No wallets match this search."
      note={
        <>
          <strong className="font-semibold">Stored wallet balance</strong> is the authoritative
          figure held on the wallet row. <strong className="font-semibold">Calculated balance</strong>{" "}
          is a diagnostic figure derived from the transaction ledger for comparison only — it is never
          written back. A difference is reported for investigation; this screen has no correction
          action.
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export function TransactionsExplorer({
  initialRows,
  initialTotal,
  initialPage,
  pageSize,
  initialFilters,
  providers,
}: {
  initialRows: AdminTransactionRow[];
  initialTotal: number;
  initialPage: number;
  pageSize: number;
  initialFilters: Record<string, string>;
  providers: string[];
}) {
  const filters: AdminFilterField[] = [
    { name: "search", label: "Search", type: "text", placeholder: "Reference, customer or recipient" },
    {
      name: "type",
      label: "Type",
      type: "select",
      options: ["data", "airtime", "deposit", "transfer", "redemption", "referral", "conversion"].map(
        (value) => ({ value, label: value }),
      ),
    },
    {
      name: "status",
      label: "Status",
      type: "select",
      options: ["successful", "pending", "failed", "reversed"].map((value) => ({ value, label: value })),
    },
    {
      name: "direction",
      label: "Direction",
      type: "select",
      options: [
        { value: "in", label: "In (credit)" },
        { value: "out", label: "Out (debit)" },
      ],
    },
    {
      name: "provider",
      label: "Provider",
      type: "select",
      options: providers.map((value) => ({ value, label: value })),
    },
    { name: "dateFrom", label: "From", type: "date" },
    { name: "dateTo", label: "To", type: "date" },
    { name: "amountMin", label: "Min GH₵", type: "number" },
    { name: "amountMax", label: "Max GH₵", type: "number" },
  ];

  const columns: AdminColumn<AdminTransactionRow>[] = [
    {
      key: "ref",
      header: "Reference",
      cell: (row) => <MonoLink href={`/admin/transactions/${encodeURIComponent(row.ref)}`}>{row.ref}</MonoLink>,
    },
    { key: "created", header: "Created", cell: (row) => <TimeCell value={row.createdAt} /> },
    {
      key: "customer",
      header: "Customer / wallet",
      cell: (row) => (
        <TwoLine
          primary={
            row.userId ? (
              <Link href={`/admin/users/${row.userId}`} className="hover:underline">
                {row.userName ?? "—"}
              </Link>
            ) : (
              <span className="opacity-60">No linked user</span>
            )
          }
          secondary={
            <Link href={`/admin/wallets/${row.walletId}`} className="hover:underline">
              Wallet #{row.walletId}
              {row.walletNumber ? ` · ${row.walletNumber}` : ""}
            </Link>
          }
        />
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (row) => (
        <TwoLine primary={<Badge>{row.type}</Badge>} secondary={`${row.direction === "in" ? "credit" : "debit"}`} />
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <StatusPill severity={TX_STATUS_SEVERITY[row.status] ?? "unknown"}>{row.status}</StatusPill>
      ),
    },
    {
      key: "fulfillment",
      header: "Delivery",
      cell: (row) => (
        <span className="text-[12px] opacity-75">
          {row.fulfillmentStatus ?? <span className="opacity-45">Not available</span>}
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      cell: (row) => (
        <TwoLine
          primary={<MoneyCell amount={row.amount} className={row.direction === "in" ? "text-emerald-600 dark:text-emerald-400" : ""} />}
          secondary={row.charged ? undefined : "not charged"}
        />
      ),
    },
    {
      key: "provider",
      header: "Provider",
      cell: (row) => (
        <TwoLine
          primary={row.provider ?? <span className="opacity-45">—</span>}
          secondary={row.providerReference ?? undefined}
        />
      ),
    },
  ];

  return (
    <AdminExplorer
      endpoint="/api/admin/transactions"
      columns={columns}
      filters={filters}
      initialFilters={initialFilters}
      initialRows={initialRows}
      initialTotal={initialTotal}
      initialPage={initialPage}
      pageSize={pageSize}
      rowKey={(row) => `tx-${row.id}`}
      emptyLabel="No transactions match these filters."
      note="Read-only. No transaction can be edited, retried, refunded or reversed from this screen."
    />
  );
}

// ---------------------------------------------------------------------------
// Data operations
// ---------------------------------------------------------------------------

const BUCKET_OPTIONS = [
  { value: "successful", label: "Successful" },
  { value: "processing", label: "Processing" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
  { value: "refunded", label: "Refunded / reversed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "attention", label: "Requires support" },
];

export function DataOrdersExplorer({
  channel,
  initialRows,
  initialTotal,
  initialPage,
  pageSize,
  initialFilters,
}: {
  channel: "wallet" | "checkout";
  initialRows: AdminDataOrderRow[];
  initialTotal: number;
  initialPage: number;
  pageSize: number;
  initialFilters: Record<string, string>;
}) {
  const filters: AdminFilterField[] = [
    { name: "search", label: "Search", type: "text", placeholder: "Reference, customer, phone or bundle" },
    { name: "bucket", label: "Delivery state", type: "select", options: BUCKET_OPTIONS },
    {
      name: "network",
      label: "Network",
      type: "select",
      options: [
        { value: "MTN", label: "MTN" },
        { value: "TELECEL", label: "Telecel" },
      ],
    },
    { name: "dateFrom", label: "From", type: "date" },
    { name: "dateTo", label: "To", type: "date" },
  ];

  const columns: AdminColumn<AdminDataOrderRow>[] = [
    {
      key: "ref",
      header: "Reference",
      cell: (row) => <MonoLink href={`/admin/transactions/${encodeURIComponent(row.ref)}`}>{row.ref}</MonoLink>,
    },
    { key: "created", header: "Created", cell: (row) => <TimeCell value={row.createdAt} /> },
    {
      key: "customer",
      header: "Customer",
      cell: (row) => (
        <TwoLine
          primary={
            row.userId ? (
              <Link href={`/admin/users/${row.userId}`} className="hover:underline">
                {row.customerName ?? "—"}
              </Link>
            ) : (
              <span className="opacity-60">No linked user</span>
            )
          }
          secondary={row.customerEmail}
        />
      ),
    },
    { key: "phone", header: "Phone", cell: (row) => <span className="font-mono text-[12px]">{row.phone}</span> },
    {
      key: "bundle",
      header: "Bundle",
      cell: (row) => (
        <TwoLine
          primary={row.bundle}
          secondary={row.network ? <Badge tone={row.network === "MTN" ? "brand" : "neutral"}>{row.network}</Badge> : undefined}
        />
      ),
    },
    { key: "amount", header: "Amount", align: "right", cell: (row) => <MoneyCell amount={row.amount} /> },
    {
      key: "payment",
      header: "Payment",
      cell: (row) => (
        <TwoLine primary={<span className="text-[12px] capitalize">{row.paymentStatus}</span>} secondary={row.walletDebit} />
      ),
    },
    {
      key: "delivery",
      header: "Delivery",
      cell: (row) => <StatusPill severity={row.deliverySeverity}>{row.delivery}</StatusPill>,
    },
    {
      key: "provider",
      header: "Provider",
      cell: (row) => (
        <TwoLine
          primary={row.provider ?? <span className="opacity-45">—</span>}
          secondary={row.providerReference ?? row.providerStatus ?? undefined}
        />
      ),
    },
    { key: "updated", header: "Updated", cell: (row) => <TimeCell value={row.updatedAt} /> },
  ];

  return (
    <AdminExplorer
      endpoint="/api/admin/data"
      fixedParams={{ channel }}
      columns={columns}
      filters={filters}
      initialFilters={initialFilters}
      initialRows={initialRows}
      initialTotal={initialTotal}
      initialPage={initialPage}
      pageSize={pageSize}
      rowKey={(row) => `${row.channel}-${row.id}`}
      emptyLabel="No orders match these filters."
      note={
        channel === "wallet"
          ? "Wallet-funded purchases: the wallet is debited first, then the bundle is submitted to the network."
          : "Paystack pay-as-you-go orders: the customer paid by card, so the wallet is never debited — those rows appear in the ledger for history and tracking only."
      }
    />
  );
}

/** Bucket counters above the data tables. */
/**
 * Bucket counts as links. Takes the channel rather than a `hrefFor` callback so
 * the Server Component page can hand it plain, serialisable props.
 */
export function BucketStrip({
  buckets,
  channel,
}: {
  buckets: Record<string, number | null>;
  channel: DataChannel;
}) {
  const hrefFor = (bucket: string) =>
    `/admin/data?${new URLSearchParams({ channel, bucket }).toString()}`;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {BUCKET_OPTIONS.map((option) => {
        const value = buckets[option.value];
        const severity: AdminSeverity =
          option.value === "failed" || option.value === "attention"
            ? "critical"
            : option.value === "pending" || option.value === "processing"
              ? "attention"
              : option.value === "successful"
                ? "healthy"
                : "unknown";
        return (
          <Link
            key={option.value}
            href={hrefFor(option.value)}
            className="rounded-xl border border-black/[0.06] bg-paper px-3 py-2 transition-shadow hover:shadow-[0_2px_12px_rgba(24,25,31,0.07)] dark:border-line dark:bg-card"
          >
            <div className="flex items-center gap-1.5">
              <SeverityDot severity={value === null ? "unknown" : severity} />
              <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
                {option.label}
              </span>
            </div>
            <p className="mt-1 font-display text-lg font-bold tabular-nums">
              {value === null ? <span className="text-[12px] font-semibold opacity-45">n/a</span> : value.toLocaleString("en-GH")}
            </p>
          </Link>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orders requiring support
// ---------------------------------------------------------------------------

export function AttentionExplorer({
  initialRows,
  initialTotal,
  initialPage,
  pageSize,
  initialFilters,
  counts,
}: {
  initialRows: AdminAttentionRow[];
  initialTotal: number;
  initialPage: number;
  pageSize: number;
  initialFilters: Record<string, string>;
  counts: { checkout: number | null; wallet: number | null; deposit: number | null };
}) {
  const filters: AdminFilterField[] = [
    { name: "search", label: "Search", type: "text", placeholder: "Reference, customer or phone" },
    {
      name: "source",
      label: "Queue",
      type: "select",
      options: [
        { value: "checkout", label: `Paystack orders${counts.checkout === null ? "" : ` (${counts.checkout})`}` },
        { value: "wallet", label: `Wallet orders${counts.wallet === null ? "" : ` (${counts.wallet})`}` },
        { value: "deposit", label: `Deposits${counts.deposit === null ? "" : ` (${counts.deposit})`}` },
      ],
    },
  ];

  const columns: AdminColumn<AdminAttentionRow>[] = [
    {
      key: "severity",
      header: "Priority",
      cell: (row) => (
        <StatusPill severity={row.severity}>{row.severity === "critical" ? "Requires support" : "Review"}</StatusPill>
      ),
    },
    {
      key: "ref",
      header: "Order",
      cell: (row) => (
        <TwoLine
          primary={<MonoLink href={`/admin/transactions/${encodeURIComponent(row.ref)}`}>{row.ref}</MonoLink>}
          secondary={<Badge>{row.source}</Badge>}
        />
      ),
    },
    {
      key: "customer",
      header: "Customer",
      cell: (row) => (
        <TwoLine
          primary={
            row.customerName ?? <span className="opacity-60">Customer not linked</span>
          }
          secondary={row.customerEmail}
        />
      ),
    },
    { key: "phone", header: "Phone", cell: (row) => <span className="font-mono text-[12px]">{row.phone}</span> },
    { key: "amount", header: "Amount", align: "right", cell: (row) => <MoneyCell amount={row.amount} /> },
    { key: "bundle", header: "Item", cell: (row) => <span className="text-[12px]">{row.bundle}</span> },
    {
      key: "status",
      header: "Current status",
      cell: (row) => <Badge tone={row.severity === "critical" ? "brand" : "neutral"}>{row.status.replace(/_/g, " ")}</Badge>,
    },
    {
      key: "reason",
      header: "Reason / status information",
      cell: (row) => <span className="block max-w-[320px] text-[12px] leading-snug opacity-75">{row.reason}</span>,
    },
    { key: "created", header: "Opened", cell: (row) => <TimeCell value={row.createdAt} /> },
  ];

  return (
    <AdminExplorer
      endpoint="/api/admin/attention"
      columns={columns}
      filters={filters}
      initialFilters={initialFilters}
      initialRows={initialRows}
      initialTotal={initialTotal}
      initialPage={initialPage}
      pageSize={pageSize}
      rowKey={(row) => `${row.source}-${row.id}`}
      emptyLabel="Nothing is waiting for support. This queue is empty."
      note="Diagnosis only: Phase 1 exposes these orders but cannot fulfil, refund or retry them."
    />
  );
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const CREDIT_SEVERITY: Record<string, AdminSeverity> = {
  credited: "healthy",
  "not-credited": "attention",
  reversed: "unknown",
  unknown: "unknown",
};

const DEPOSIT_SEVERITY: Record<string, AdminSeverity> = {
  successful: "healthy",
  pending: "attention",
  failed: "critical",
  abandoned: "unknown",
};

export function PaymentsExplorer({
  initialRows,
  initialTotal,
  initialPage,
  pageSize,
  initialFilters,
  providers,
  channels,
  summary,
}: {
  initialRows: AdminPaymentRow[];
  initialTotal: number;
  initialPage: number;
  pageSize: number;
  initialFilters: Record<string, string>;
  providers: string[];
  channels: string[];
  summary: Record<string, number | null>;
}) {
  const filters: AdminFilterField[] = [
    { name: "search", label: "Search", type: "text", placeholder: "Reference, customer or Paystack id" },
    {
      name: "status",
      label: "Status",
      type: "select",
      options: [
        { value: "successful", label: "Successful" },
        { value: "pending", label: "Pending" },
        { value: "failed", label: "Failed" },
        { value: "abandoned", label: "Abandoned" },
      ],
    },
    {
      name: "provider",
      label: "Provider",
      type: "select",
      options: providers.map((value) => ({ value, label: value })),
    },
    {
      name: "channel",
      label: "Channel",
      type: "select",
      options: channels.map((value) => ({ value, label: value })),
    },
    {
      name: "credit",
      label: "Wallet credit",
      type: "select",
      options: [
        { value: "credited", label: "Credited" },
        { value: "not-credited", label: "Not credited" },
        { value: "reversed", label: "Reversed" },
      ],
    },
    { name: "dateFrom", label: "From", type: "date" },
    { name: "dateTo", label: "To", type: "date" },
  ];

  const columns: AdminColumn<AdminPaymentRow>[] = [
    {
      key: "ref",
      header: "Payment reference",
      cell: (row) => (
        <TwoLine
          primary={<MonoLink href={`/admin/payments?search=${encodeURIComponent(row.ref)}`}>{row.ref}</MonoLink>}
          secondary={row.paystackTransactionId ? `Paystack ${row.paystackTransactionId}` : undefined}
        />
      ),
    },
    { key: "initiated", header: "Initiated", cell: (row) => <TimeCell value={row.initiatedAt} /> },
    {
      key: "customer",
      header: "Customer / wallet",
      cell: (row) => (
        <TwoLine
          primary={
            row.userId ? (
              <Link href={`/admin/users/${row.userId}`} className="hover:underline">
                {row.userName ?? "—"}
              </Link>
            ) : (
              <span className="opacity-60">No linked user</span>
            )
          }
          secondary={
            <Link href={`/admin/wallets/${row.walletId}`} className="hover:underline">
              Wallet #{row.walletId}
            </Link>
          }
        />
      ),
    },
    { key: "amount", header: "Amount", align: "right", cell: (row) => <MoneyCell amount={row.amount} /> },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <StatusPill severity={DEPOSIT_SEVERITY[row.status] ?? "unknown"}>{row.status}</StatusPill>
      ),
    },
    {
      key: "credit",
      header: "Wallet credit",
      cell: (row) => (
        <TwoLine
          primary={
            <StatusPill severity={CREDIT_SEVERITY[row.walletCredit] ?? "unknown"}>
              {row.walletCredit === "credited"
                ? "Credited"
                : row.walletCredit === "not-credited"
                  ? "Not credited"
                  : row.walletCredit === "reversed"
                    ? "Reversed"
                    : "Unknown"}
            </StatusPill>
          }
          secondary={row.walletCreditedAt ? `at ${formatDateTime(row.walletCreditedAt)}` : undefined}
        />
      ),
    },
    {
      key: "provider",
      header: "Provider / channel",
      cell: (row) => <TwoLine primary={row.provider} secondary={row.channel ?? row.method} />,
    },
    {
      key: "timeline",
      header: "Paid / verified / completed",
      cell: (row) => (
        <div className="text-[11px] leading-snug tabular-nums opacity-70">
          <div>{formatDateTime(row.paidAt)}</div>
          <div>{formatDateTime(row.verifiedAt)}</div>
          <div>{formatDateTime(row.completedAt)}</div>
        </div>
      ),
    },
    {
      key: "response",
      header: "Gateway response",
      cell: (row) => <span className="block max-w-[220px] text-[12px] leading-snug opacity-70">{row.gatewayResponse ?? "—"}</span>,
    },
  ];

  return (
    <AdminExplorer
      endpoint="/api/admin/payments"
      columns={columns}
      filters={filters}
      initialFilters={initialFilters}
      initialRows={initialRows}
      initialTotal={initialTotal}
      initialPage={initialPage}
      pageSize={pageSize}
      rowKey={(row) => `deposit-${row.id}`}
      emptyLabel="No deposits match these filters."
      note={
        <>
          Wallet-credit state is derived by looking for the matching ledger row (same reference,
          inbound, successful). Read-only: no payment is retried, refunded or re-verified from this
          screen, and Paystack is never called.
          {summary.successful !== null && summary.successfulValue !== null && (
            <>
              {" "}
              Lifetime: {summary.successful.toLocaleString("en-GH")} successful deposits worth{" "}
              {adminMoney(summary.successfulValue)}.
            </>
          )}
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export function ReconciliationExplorer({
  initialRows,
  initialTotal,
  initialPage,
  pageSize,
  initialFilters,
  rule,
  mismatches,
  walletsExamined,
}: {
  initialRows: AdminReconciliationRow[];
  initialTotal: number;
  initialPage: number;
  pageSize: number;
  initialFilters: Record<string, string>;
  rule: { id: string; label: string; exact: boolean; note: string };
  mismatches: number;
  walletsExamined: number;
}) {
  const filters: AdminFilterField[] = [
    { name: "search", label: "Search", type: "text", placeholder: "Wallet, name, email or phone" },
    {
      name: "onlyMismatches",
      label: "Result",
      type: "select",
      options: [{ value: "1", label: "Mismatches only" }],
    },
  ];

  const columns: AdminColumn<AdminReconciliationRow>[] = [
    {
      key: "wallet",
      header: "Wallet",
      cell: (row) => (
        <TwoLine
          primary={<MonoLink href={`/admin/wallets/${row.walletId}`}>#{row.walletId}</MonoLink>}
          secondary={row.walletNumber}
        />
      ),
    },
    {
      key: "customer",
      header: "User",
      cell: (row) => (
        <TwoLine
          primary={
            row.userId ? (
              <Link href={`/admin/users/${row.userId}`} className="hover:underline">
                {row.userName ?? "—"}
              </Link>
            ) : (
              <span className="opacity-60">No linked user</span>
            )
          }
          secondary={row.userEmail}
        />
      ),
    },
    { key: "stored", header: "Stored balance", align: "right", cell: (row) => <MoneyCell amount={row.storedBalance} /> },
    {
      key: "calculated",
      header: "Calculated balance",
      align: "right",
      cell: (row) => <MoneyCell amount={row.calculatedBalance} muted />,
    },
    { key: "difference", header: "Difference", align: "right", cell: (row) => <MoneyDelta amount={row.difference} /> },
    {
      key: "status",
      header: "Status",
      cell: (row) => <StatusPill severity={row.severity}>{row.label}</StatusPill>,
    },
    {
      key: "examined",
      header: "Txns examined",
      align: "right",
      cell: (row) => <span className="tabular-nums opacity-70">{row.transactionsExamined ?? "—"}</span>,
    },
    { key: "last", header: "Last relevant txn", cell: (row) => <TimeCell value={row.lastTransactionAt} /> },
    {
      key: "inspect",
      header: "",
      align: "right",
      cell: (row) => (
        <Link href={`/admin/wallets/${row.walletId}`} className="text-[12px] font-semibold text-brand-deep hover:underline dark:text-brand">
          Inspect
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <Panel
        title="How this figure is calculated"
        subtitle={`${walletsExamined.toLocaleString("en-GH")} wallets examined · ${mismatches.toLocaleString("en-GH")} mismatched`}
      >
        <div className="space-y-2">
          <p className="text-[12px] leading-relaxed">
            <strong className="font-semibold">{rule.label}.</strong> {rule.note}
          </p>
          <Note>
            The stored wallet balance remains the single source of truth. This screen is a diagnostic
            comparison and cannot correct a difference — there is no fix, adjust or set-balance action
            anywhere in Phase 1.
          </Note>
        </div>
      </Panel>

      <AdminExplorer
        endpoint="/api/admin/reconciliation"
        columns={columns}
        filters={filters}
        initialFilters={initialFilters}
        initialRows={initialRows}
        initialTotal={initialTotal}
        initialPage={initialPage}
        pageSize={pageSize}
        rowKey={(row) => `recon-${row.walletId}`}
        emptyLabel={
          initialFilters.onlyMismatches
            ? "No wallet mismatches found."
            : "No wallets match this search."
        }
        note="Every difference is reported as “Requires investigation”. The dashboard never names a cause: several benign patterns produce the same arithmetic."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export function UsersExplorer({
  initialRows,
  initialTotal,
  initialPage,
  pageSize,
  initialFilters,
}: {
  initialRows: AdminUserRow[];
  initialTotal: number;
  initialPage: number;
  pageSize: number;
  initialFilters: Record<string, string>;
}) {
  const filters: AdminFilterField[] = [
    { name: "search", label: "Search", type: "text", placeholder: "Name, email, phone or referral code" },
    {
      name: "sort",
      label: "Sort by",
      type: "select",
      options: [
        { value: "recent", label: "Newest" },
        { value: "balance", label: "Largest balance" },
        { value: "name", label: "Name" },
        { value: "id", label: "User ID" },
      ],
    },
  ];

  const columns: AdminColumn<AdminUserRow>[] = [
    {
      key: "user",
      header: "Customer",
      cell: (row) => (
        <TwoLine
          primary={
            <Link href={`/admin/users/${row.userId}`} className="font-semibold hover:underline">
              {row.name}
            </Link>
          }
          secondary={`#${row.userId} · joined ${formatDate(row.createdAt)}`}
        />
      ),
    },
    { key: "email", header: "Email", cell: (row) => <span className="font-mono text-[12px]">{row.email}</span> },
    { key: "phone", header: "Phone", cell: (row) => <span className="font-mono text-[12px]">{row.phone}</span> },
    {
      key: "wallet",
      header: "Wallet",
      cell: (row) =>
        row.walletId ? (
          <TwoLine
            primary={
              <MonoLink href={`/admin/wallets/${row.walletId}`}>#{row.walletId}</MonoLink>
            }
            secondary={row.walletCount > 1 ? `${row.walletCount} wallets — review` : undefined}
          />
        ) : (
          <span className="text-[12px] text-rose-600 dark:text-rose-400">No wallet</span>
        ),
    },
    { key: "balance", header: "Balance", align: "right", cell: (row) => <MoneyCell amount={row.balance} /> },
    {
      key: "points",
      header: "Points",
      align: "right",
      cell: (row) => <span className="tabular-nums opacity-70">{row.points.toLocaleString("en-GH")}</span>,
    },
    {
      key: "activity",
      header: "Sessions / last seen",
      cell: (row) => (
        <TwoLine
          primary={`${row.activeSessions ?? 0} active`}
          secondary={row.lastSeenAt ? formatDateTime(row.lastSeenAt) : "never"}
        />
      ),
    },
    {
      key: "flags",
      header: "Account",
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.isAdmin && <Badge tone="brand">admin</Badge>}
          {!row.emailVerifiedAt && <Badge>email unverified</Badge>}
          {row.walletCount > 1 && <Badge>multiple wallets</Badge>}
          {!row.isAdmin && row.emailVerifiedAt && row.walletCount <= 1 && <span className="opacity-45">—</span>}
        </div>
      ),
    },
    {
      key: "open",
      header: "",
      align: "right",
      cell: (row) => (
        <Link href={`/admin/users/${row.userId}`} className="text-[12px] font-semibold text-brand-deep hover:underline dark:text-brand">
          Open
        </Link>
      ),
    },
  ];

  return (
    <AdminExplorer
      endpoint="/api/admin/users"
      columns={columns}
      filters={filters}
      initialFilters={initialFilters}
      initialRows={initialRows}
      initialTotal={initialTotal}
      initialPage={initialPage}
      pageSize={pageSize}
      rowKey={(row) => `user-${row.userId}`}
      emptyLabel="No customers match this search."
      note="Contact details are masked in lists and shown in full only on a deliberately opened customer page. Accounts cannot be created, edited, suspended or promoted here."
    />
  );
}
