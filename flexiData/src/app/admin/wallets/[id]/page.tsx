import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/auth";
import { loadWalletDetail } from "@/lib/admin/queries";
import { AdminPageHead } from "@/components/admin/page-head";
import { Badge, KeyValues, MoneyCell, MoneyDelta, Note, Panel, StatusPill } from "@/components/admin/ui";
import { adminMoney, formatDateTime } from "@/lib/admin/format";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";

/**
 * `/admin/wallets/[id]` — one wallet: stored vs calculated, the ledger rows that
 * produced the calculation, and credit/debit totals.
 *
 * The contributing transactions are shown as EVIDENCE of what was summed, never
 * as an accusation: the copy says "requires investigation" because several
 * legitimate patterns produce the same arithmetic.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Wallet · FlexiData" };

export default async function AdminWalletDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  await requireAdmin();

  const { id } = await params;
  const walletId = Number(id);
  if (!Number.isInteger(walletId) || walletId <= 0) notFound();

  const query = await searchParams;
  const page = parsePage(q(query, "page"));
  const pageSize = parsePageSize(q(query, "pageSize"));

  const detail = await loadWalletDetail(walletId, page, pageSize);
  if (!detail) notFound();

  const { wallet, reconciliation } = detail;

  return (
    <div className="space-y-4">
      <AdminPageHead
        title={`Wallet #${wallet.walletId}`}
        subtitle="Stored balance is the authoritative figure. The calculated balance is a diagnostic comparison and is never written back."
        actions={
          <Link href="/admin/wallets" className="text-[12px] font-semibold opacity-65 hover:opacity-100">
            ← All wallets
          </Link>
        }
      />

      <Panel
        title="Balance comparison"
        subtitle={reconciliation.rule.label}
        bodyClassName="px-4 py-4"
      >
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-3">
            <div className="rounded-xl border border-black/[0.06] bg-black/[0.015] px-3 py-3 dark:border-line dark:bg-white/[0.03]">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
                Stored wallet balance
              </p>
              <p className="mt-1 font-display text-2xl font-bold tabular-nums">
                {adminMoney(reconciliation.storedBalance)}
              </p>
              <p className="mt-1 text-[11px] opacity-55">
                The authoritative figure, held on the wallet row.
              </p>
            </div>
            <div className="rounded-xl border border-black/[0.06] px-3 py-3 dark:border-line">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
                Calculated / expected balance
              </p>
              <p className="mt-1 font-display text-2xl font-bold tabular-nums opacity-70">
                {reconciliation.calculatedBalance === null
                  ? "Not available"
                  : adminMoney(reconciliation.calculatedBalance)}
              </p>
              <p className="mt-1 text-[11px] opacity-55">
                Derived from {reconciliation.transactionsExamined ?? 0} money-moving ledger rows.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="rounded-xl border border-black/[0.06] px-3 py-3 dark:border-line">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
                Difference
              </p>
              <p className="mt-1 font-display text-2xl font-bold">
                <MoneyDelta amount={reconciliation.difference} />
              </p>
              <div className="mt-2">
                <StatusPill severity={reconciliation.severity}>{reconciliation.label}</StatusPill>
              </div>
              <p className="mt-2 text-[12px] font-semibold">{reconciliation.guidance}</p>
            </div>
            <Note>
              A difference is not proof of a fault. The dashboard does not guess which transaction is
              responsible — the rows below are what the calculation used.
            </Note>
          </div>
        </div>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Wallet" bodyClassName="px-4 py-3">
          <KeyValues
            items={[
              { label: "Wallet ID", value: `#${wallet.walletId}`, mono: true },
              { label: "Wallet number", value: wallet.walletNumber, mono: true },
              { label: "Holder", value: wallet.userName ?? "No linked user" },
              { label: "User ID", value: wallet.userId === null ? "Unlinked" : `#${wallet.userId}` },
              {
                label: "Customer",
                value:
                  wallet.userId === null ? (
                    "—"
                  ) : (
                    <Link href={`/admin/users/${wallet.userId}`} className="hover:underline">
                      Open customer
                    </Link>
                  ),
              },
              { label: "Email", value: wallet.userEmail },
              { label: "Phone", value: wallet.userPhone, mono: true },
              { label: "Points", value: wallet.points.toLocaleString("en-GH") },
              { label: "Agent", value: wallet.isAgent ? (wallet.agentTier ?? "Yes") : "No" },
              { label: "Created", value: formatDateTime(wallet.createdAt) },
              { label: "Last movement", value: formatDateTime(reconciliation.lastTransactionAt) },
            ]}
          />
        </Panel>

        <Panel title="Ledger totals" bodyClassName="px-4 py-3">
          <KeyValues
            items={[
              {
                label: "Successful credits",
                value: (
                  <span>
                    {adminMoney(detail.totals.credits)}{" "}
                    <span className="opacity-55">({detail.totals.successfulCredits} rows)</span>
                  </span>
                ),
              },
              {
                label: "Successful debits",
                value: (
                  <span>
                    {adminMoney(detail.totals.debits)}{" "}
                    <span className="opacity-55">({detail.totals.successfulDebits} rows)</span>
                  </span>
                ),
              },
              {
                label: "Reversals / refunds recorded",
                value: detail.totals.reversals.toLocaleString("en-GH"),
              },
              {
                label: "Rows examined",
                value: (reconciliation.transactionsExamined ?? 0).toLocaleString("en-GH"),
              },
            ]}
          />
          <div className="mt-3 space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
              Before concluding a defect, rule out
            </p>
            <ul className="list-disc space-y-1 pl-4 text-[12px] leading-relaxed opacity-70">
              {reconciliation.causes.map((cause) => (
                <li key={cause}>{cause}</li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>

      <Panel
        title="Transactions that contributed to the calculated balance"
        subtitle={`${detail.contributionsTotal.toLocaleString("en-GH")} money-moving rows. Rows that never moved money are excluded by definition.`}
        bodyClassName="px-0 py-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-black/[0.06] bg-black/[0.015] text-[10px] uppercase tracking-[0.1em] text-zinc-500 dark:border-line dark:bg-white/[0.02]">
                <th className="px-3 py-2.5">Reference</th>
                <th className="px-3 py-2.5">Created</th>
                <th className="px-3 py-2.5">Type</th>
                <th className="px-3 py-2.5">Direction</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5 text-right">Amount</th>
                <th className="px-3 py-2.5">Charged</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.04] dark:divide-white/[0.05]">
              {detail.contributions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-[13px] opacity-55">
                    No money-moving ledger rows for this wallet.
                  </td>
                </tr>
              ) : (
                detail.contributions.map((tx) => (
                  <tr key={tx.id}>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/admin/transactions/${encodeURIComponent(tx.ref)}`}
                        className="font-mono text-[12px] font-semibold text-brand-deep hover:underline dark:text-brand"
                      >
                        {tx.ref}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] tabular-nums opacity-70">
                      {formatDateTime(tx.createdAt)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge>{tx.type}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] capitalize">{tx.direction}</td>
                    <td className="px-3 py-2.5 text-[12px] capitalize">{tx.status}</td>
                    <td className="px-3 py-2.5 text-right">
                      <MoneyCell amount={tx.amount} />
                    </td>
                    <td className="px-3 py-2.5 text-[12px] opacity-70">
                      {tx.charged ? formatDateTime(tx.chargedAt) : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {detail.contributionsTotal > detail.contributions.length && (
          <div className="border-t border-black/[0.05] px-4 py-2 dark:border-line">
            <Note>
              Showing {detail.contributions.length} of {detail.contributionsTotal} rows. Use the API
              with a different page size to page through the full set.
            </Note>
          </div>
        )}
      </Panel>

      <Note>
        Read-only view. No adjustment, correction or balance entry exists in this phase — Phase 1 is
        diagnosis only.
      </Note>
    </div>
  );
}
