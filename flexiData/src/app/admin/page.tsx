import Link from "next/link";
import { requireAdmin } from "@/lib/admin/auth";
import { loadOverview } from "@/lib/admin/queries";
import { AdminPageHead } from "@/components/admin/page-head";
import { Badge, Note, Panel, SEVERITY_STYLES, SeverityDot, StatTile } from "@/components/admin/ui";
import { adminMoney, formatDateTime } from "@/lib/admin/format";
import type { AdminSeverity } from "@/lib/admin/types";

/**
 * `/admin` — the operations overview.
 *
 * Operational problems come first: the "Needs attention" panel is rendered above
 * the statistics, because the job of this screen is to answer "what is broken and
 * for whom", not to decorate a dashboard.
 *
 * Any figure that cannot be derived reliably from the existing data — for
 * example delivery states on a database that predates the gateway columns — is
 * rendered as "Not available" rather than as a zero that would read as "all
 * clear".
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Overview · FlexiData" };

export default async function AdminOverviewPage() {
  // The layout has already authorized this request; a page must never assume
  // its layout ran the check.
  await requireAdmin();

  const overview = await loadOverview();
  const { counts } = overview;

  const metricSeverity = (value: number | null, attention = 0): AdminSeverity => {
    if (value === null) return "unknown";
    if (value > attention) return "critical";
    if (value > 0) return "attention";
    return "healthy";
  };

  return (
    <div className="space-y-4">
      <AdminPageHead
        title="Operations overview"
        subtitle="A read-only snapshot of the platform. Nothing on this screen can move money, change a balance or alter an order."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={overview.paystackMode === "live" ? "brand" : "neutral"}>
              Paystack {overview.paystackMode}
            </Badge>
            <Badge>Read-only</Badge>
          </div>
        }
      />

      <Panel
        title="Needs attention"
        subtitle="Ordered by severity. These are the things an operator has to act on; everything below is context."
        bodyClassName="px-4 py-2"
      >
        {overview.issues.length === 0 ? (
          <div className="flex items-center gap-2 py-4">
            <SeverityDot severity="healthy" />
            <p className="text-[13px]">
              No operational problems detected. Every queue is empty and no wallet discrepancy was
              found.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
            {overview.issues.map((issue) => (
              <li key={issue.id}>
                <Link
                  href={issue.href}
                  className="flex items-start gap-3 py-3 transition-opacity hover:opacity-80"
                >
                  <span className="mt-1.5">
                    <SeverityDot severity={issue.severity} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="text-[13px] font-bold">{issue.label}</span>
                      <span className="font-display text-[15px] font-bold tabular-nums text-rose-600 dark:text-rose-400">
                        {issue.count.toLocaleString("en-GH")}
                      </span>
                      <span
                        className={`text-[10px] font-bold uppercase tracking-wide ${SEVERITY_STYLES[issue.severity].text}`}
                      >
                        {SEVERITY_STYLES[issue.severity].label}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug opacity-65">{issue.detail}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <section>
        <h2 className="mb-2 font-display text-[13px] font-bold tracking-tight">Customers &amp; money</h2>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatTile label="Total users" value={counts.users} severity="unknown" />
          <StatTile
            label="Total wallet balance"
            value={counts.totalWalletBalance}
            money
            severity="unknown"
            hint="Sum of every stored wallet balance"
          />
          <StatTile
            label="Successful deposits"
            value={counts.successfulDeposits}
            severity="unknown"
            hint={
              counts.successfulDepositsValue === null
                ? undefined
                : `${adminMoney(counts.successfulDepositsValue)} credited`
            }
          />
          <StatTile
            label="Successful data purchases"
            value={counts.successfulPurchases}
            severity="unknown"
            hint={
              counts.successfulPurchasesValue === null
                ? undefined
                : `${adminMoney(counts.successfulPurchasesValue)} of bundles and airtime`
            }
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 font-display text-[13px] font-bold tracking-tight">Ledger state</h2>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatTile
            label="Pending transactions"
            value={counts.pendingTransactions}
            severity={metricSeverity(counts.pendingTransactions)}
            href="/admin/transactions?status=pending"
          />
          <StatTile
            label="Failed transactions"
            value={counts.failedTransactions}
            severity={metricSeverity(counts.failedTransactions)}
            href="/admin/transactions?status=failed"
          />
          <StatTile
            label="Reversed transactions"
            value={counts.reversedTransactions}
            severity={metricSeverity(counts.reversedTransactions)}
            href="/admin/transactions?status=reversed"
          />
          <StatTile
            label="Wallet discrepancies"
            value={counts.walletDiscrepancies}
            severity={metricSeverity(counts.walletDiscrepancies)}
            href="/admin/reconciliation?only=mismatches"
            hint="Stored balance vs ledger-derived balance"
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 font-display text-[13px] font-bold tracking-tight">Delivery &amp; funding</h2>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatTile
            label="Pending data deliveries"
            value={counts.pendingDeliveries}
            severity={metricSeverity(counts.pendingDeliveries)}
            href="/admin/data?bucket=pending"
          />
          <StatTile
            label="Failed data deliveries"
            value={counts.failedDeliveries}
            severity={metricSeverity(counts.failedDeliveries)}
            href="/admin/data?bucket=failed"
          />
          <StatTile
            label="Orders requiring support"
            value={counts.supportQueue}
            severity={metricSeverity(counts.supportQueue)}
            href="/admin/attention"
            hint="Paid orders the checkout flow parked for manual resolution"
          />
          <StatTile
            label="Stuck paid orders"
            value={counts.stuckCheckoutOrders}
            severity={metricSeverity(counts.stuckCheckoutOrders)}
            href="/admin/attention?source=checkout"
            hint="Paid but unfulfilled for over two hours"
          />
          <StatTile
            label="Pending deposits"
            value={counts.pendingDeposits}
            severity={metricSeverity(counts.pendingDeposits)}
            href="/admin/payments?status=pending"
          />
          <StatTile
            label="Failed deposits"
            value={counts.failedDeposits}
            severity={metricSeverity(counts.failedDeposits)}
            href="/admin/payments?status=failed"
          />
          <StatTile
            label="Abandoned deposits"
            value={counts.abandonedDeposits}
            severity={metricSeverity(counts.abandonedDeposits)}
            href="/admin/payments?status=abandoned"
          />
          <StatTile
            label="Paystack orders fulfilled"
            value={counts.fulfilledCheckoutOrders}
            severity="unknown"
            href="/admin/data?channel=checkout"
          />
        </div>
      </section>

      {overview.float.available && (
        <Panel
          title="Provider float"
          subtitle="Aggregator balance per network, as last reported by the data gateway."
          bodyClassName="px-4 py-3"
        >
          {overview.float.rows.length === 0 ? (
            <Note>No provider float has been recorded yet.</Note>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-[13px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.1em] text-zinc-500">
                    <th className="py-2 pr-3">Network</th>
                    <th className="py-2 pr-3">Provider</th>
                    <th className="py-2 pr-3 text-right">Available</th>
                    <th className="py-2 pr-3 text-right">Reserved</th>
                    <th className="py-2 pr-3 text-right">Threshold</th>
                    <th className="py-2 pr-3">Last sync</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.04] dark:divide-white/[0.05]">
                  {overview.float.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 pr-3 font-semibold">{row.network}</td>
                      <td className="py-2 pr-3 opacity-70">{row.providerCode}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        <span className={row.belowThreshold ? "font-bold text-rose-600 dark:text-rose-400" : ""}>
                          {adminMoney(row.availableBalance)}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums opacity-70">
                        {adminMoney(row.reservedBalance)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums opacity-70">
                        {adminMoney(row.lowBalanceThreshold)}
                      </td>
                      <td className="py-2 pr-3 text-[12px] opacity-70">{formatDateTime(row.lastSyncedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      <Panel title="Data availability" subtitle="Which of these figures this database can support.">
        <div className="space-y-2">
          <ul className="grid gap-1.5 text-[12px] sm:grid-cols-2 lg:grid-cols-3">
            <li className="flex items-center gap-2">
              <SeverityDot severity={overview.caps.chargedAt ? "healthy" : "attention"} />
              Ledger charged/refunded flags {overview.caps.chargedAt ? "present" : "missing"}
            </li>
            <li className="flex items-center gap-2">
              <SeverityDot severity={overview.caps.fulfillmentStatus ? "healthy" : "attention"} />
              Delivery status column {overview.caps.fulfillmentStatus ? "present" : "missing"}
            </li>
            <li className="flex items-center gap-2">
              <SeverityDot severity={overview.caps.reversedStatus ? "healthy" : "attention"} />
              “reversed” ledger status {overview.caps.reversedStatus ? "supported" : "unsupported"}
            </li>
            <li className="flex items-center gap-2">
              <SeverityDot severity={overview.caps.checkoutTable ? "healthy" : "attention"} />
              Checkout orders table {overview.caps.checkoutTable ? "present" : "missing"}
            </li>
            <li className="flex items-center gap-2">
              <SeverityDot severity={overview.caps.floatTable ? "healthy" : "attention"} />
              Provider float table {overview.caps.floatTable ? "present" : "missing"}
            </li>
          </ul>
          <Note>
            Where a column or table is missing the dependent metric reads “Not available” instead of
            zero. Reconciliation figures are labelled as estimates when the ledger flags are absent.
            Generated {formatDateTime(overview.generatedAt)}.
          </Note>
        </div>
      </Panel>
    </div>
  );
}
