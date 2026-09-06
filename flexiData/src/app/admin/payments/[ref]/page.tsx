import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/auth";
import { parseRef } from "@/lib/admin/filters";
import { loadDepositDetail } from "@/lib/admin/queries-investigation";
import { AdminPageHead } from "@/components/admin/page-head";
import { Badge, MoneyCell, MoneyDelta, Note, Panel } from "@/components/admin/ui";
import {
  FactsPanel,
  FindingsPanel,
  RecordedActionsPanel,
  VerdictBanner,
} from "@/components/admin/investigation";
import { PaystackStatusProbe } from "@/components/admin/paystack-probe";
import { adminMoney, formatDateTime } from "@/lib/admin/format";

/**
 * `/admin/payments/[ref]` — one wallet funding attempt, investigated in full.
 *
 * Phase 2, Step 3 (S3.3). The payments list previously linked a reference to a
 * filtered view of itself, so the deposit an operator most needs to inspect —
 * one parked by the Paystack verification-mismatch guard, or one left `pending`
 * for a day — had no record view. This is that view.
 *
 * Read-only, and pointedly so: `reconcileDeposit()` is the only code that can
 * settle one of these, and it increments a wallet balance and inserts a ledger
 * row. It is not imported here and is not reachable from anything on this page.
 * What this page can do is show, side by side, the deposit we recorded, the
 * ledger rows that carry its reference, and the owning wallet's
 * stored-vs-calculated verdict (the SAME rule the reconciliation screen uses),
 * then classify the combination with the pure diagnosis engine.
 *
 * When Paystack holds a matching successful charge that we never settled, the
 * finding says so and names the only route that may act on it: the customer's
 * own verify path. This dashboard never settles a deposit.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Payment · FlexiData" };

export default async function AdminDepositInvestigationPage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  await requireAdmin();

  const { ref } = await params;
  const depositRef = parseRef(ref);
  if (!depositRef) notFound();

  const result = await loadDepositDetail(depositRef);
  if (!result) notFound();

  const { deposit, creditRows, walletReconciliation, findings, verdict } = result;

  return (
    <div className="space-y-4">
      <AdminPageHead
        title={`Deposit ${deposit.ref}`}
        subtitle={`Wallet top-up · ${deposit.method} via ${deposit.provider} · ${adminMoney(deposit.amount)} ${deposit.currency}`}
        actions={
          <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold opacity-65">
            <Link href="/admin/payments" className="hover:opacity-100">
              ← Payments
            </Link>
            <Link href="/admin/attention?source=deposit" className="hover:opacity-100">
              Requires support
            </Link>
            {deposit.walletId && (
              <Link href={`/admin/wallets/${deposit.walletId}`} className="hover:opacity-100">
                Wallet
              </Link>
            )}
          </div>
        }
      />

      <Panel bodyClassName="px-4 py-3">
        <VerdictBanner
          verdict={verdict}
          findings={findings}
          footer={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="mono">status: {deposit.status}</Badge>
              <Badge tone="mono">wallet credit: {deposit.walletCredit}</Badge>
              <Badge tone="mono">provider: {deposit.provider}</Badge>
            </div>
          }
        />
        <Note className="mt-3 border-t border-black/[0.05] pt-2 dark:border-line">
          No action on this page can settle, credit, reverse or refund this deposit. If the gateway
          confirms a charge we never settled, the customer&apos;s own verification path is the only
          code that may credit the wallet.
        </Note>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-3">
        <FactsPanel
          title="Money (display only)"
          items={[
            { label: "Amount", value: <MoneyCell amount={deposit.amount} /> },
            {
              label: "Pesewas to verify (authoritative)",
              value:
                deposit.amountSubunits === null
                  ? "Not recorded"
                  : deposit.amountSubunits.toLocaleString("en-GH"),
              mono: true,
            },
            { label: "Currency", value: deposit.currency },
            { label: "Status", value: deposit.status },
            { label: "Credited to wallet", value: deposit.creditedAt ? formatDateTime(deposit.creditedAt) : "No credit recorded" },
            {
              label: "Credited amount",
              value: deposit.creditedAmount === null ? "—" : adminMoney(deposit.creditedAmount),
            },
          ]}
        />

        <FactsPanel
          title="Paystack trail"
          subtitle="Stored audit columns only — never key material, never a raw payload."
          items={[
            { label: "Transaction id", value: deposit.paystackTransactionId ?? "—", mono: true },
            { label: "Channel", value: deposit.paystackChannel ?? "—" },
            { label: "Gateway response", value: deposit.paystackGatewayResponse ?? "—" },
            { label: "Method", value: deposit.method },
          ]}
        />

        <FactsPanel
          title="Wallet position"
          subtitle="Stored balance versus the figure derived from the ledger, using the reconciliation screen's own rule."
          items={[
            {
              label: "Wallet",
              value: (
                <Link href={`/admin/wallets/${deposit.walletId}`} className="font-semibold hover:underline">
                  #{deposit.walletId} {deposit.walletNumber ? `(${deposit.walletNumber})` : ""}
                </Link>
              ),
            },
            {
              label: "Stored balance",
              value: walletReconciliation.storedBalance === null ? "Not available" : adminMoney(walletReconciliation.storedBalance),
            },
            {
              label: "Calculated from ledger",
              value:
                walletReconciliation.calculatedBalance === null
                  ? "Not available"
                  : adminMoney(walletReconciliation.calculatedBalance),
            },
            { label: "Difference", value: <MoneyDelta amount={walletReconciliation.difference} /> },
            { label: "Verdict", value: walletReconciliation.label },
          ]}
          footer={<Note className="mt-2">{walletReconciliation.guidance}</Note>}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <Panel
            title="Ledger rows carrying this reference"
            subtitle="Evidence, not an accusation: these are the rows the credit check counted."
            bodyClassName="px-4 py-3"
          >
            {creditRows.length === 0 ? (
              <Note>
                No ledger row carries this reference — the wallet was never credited for it.
                {deposit.status === "successful"
                  ? " That contradicts the deposit status and is flagged above as critical."
                  : ""}
              </Note>
            ) : (
              <ul className="divide-y divide-black/[0.04] dark:divide-white/[0.05]">
                {creditRows.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <Link
                        href={`/admin/transactions/${encodeURIComponent(row.ref)}`}
                        className="font-mono text-[12px] font-semibold text-brand-deep hover:underline dark:text-brand"
                      >
                        #{row.id}
                      </Link>
                      <p className="text-[12px] opacity-75">
                        {row.title} · {row.direction === "in" ? "credit" : "debit"} ·{" "}
                        <span className="font-semibold">{adminMoney(row.amount)}</span>
                      </p>
                      <p className="text-[11px] opacity-55">
                        {row.status}
                        {row.fulfillmentStatus ? ` · ${row.fulfillmentStatus}` : ""} · created{" "}
                        {formatDateTime(row.createdAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone="mono">{row.type}</Badge>
                      <Badge tone="mono">{row.direction}</Badge>
                      <Badge tone="mono">{row.status}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <FindingsPanel findings={findings} />

          <PaystackStatusProbe
            endpoint={`/api/admin/payments/${encodeURIComponent(deposit.ref)}/paystack-status`}
            available={result.probe.available}
            mode={result.probe.mode}
            reason={result.probe.reason}
            subjectLabel={`deposit ${deposit.ref}`}
          />
        </div>

        <div className="space-y-3">
          <FactsPanel
            title="Customer"
            items={[
              { label: "Name", value: deposit.customerName ?? "—" },
              { label: "Email", value: deposit.customerEmail },
              { label: "Phone", value: deposit.customerPhone },
              {
                label: "Account",
                value:
                  deposit.userId === null ? (
                    "No linked account"
                  ) : (
                    <Link href={`/admin/users/${deposit.userId}`} className="font-semibold hover:underline">
                      #{deposit.userId}
                    </Link>
                  ),
              },
            ]}
          />

          <FactsPanel
            title="Timestamps"
            items={[
              { label: "Initiated", value: formatDateTime(deposit.initiatedAt) },
              { label: "Paid", value: formatDateTime(deposit.paidAt) },
              { label: "Verified", value: formatDateTime(deposit.verifiedAt) },
              { label: "Completed", value: formatDateTime(deposit.completedAt) },
              { label: "Updated", value: formatDateTime(deposit.updatedAt) },
            ]}
          />

          <RecordedActionsPanel
            title="Customer account actions"
            actions={result.accountActions}
            available={result.auditAvailable}
            emptyLabel="No suspend or activate has been recorded for this customer."
          />
        </div>
      </div>
    </div>
  );
}
