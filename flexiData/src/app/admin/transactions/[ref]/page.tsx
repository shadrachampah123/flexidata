import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/auth";
import { loadTransactionDetail } from "@/lib/admin/queries-operations";
import { AdminPageHead } from "@/components/admin/page-head";
import { Badge, KeyValues, MoneyCell, Note, Panel, StatusPill } from "@/components/admin/ui";
import { adminMoney, formatDateTime } from "@/lib/admin/format";
import type { AdminSeverity } from "@/lib/admin/types";

/**
 * `/admin/transactions/[ref]` — one ledger row in full.
 *
 * A deliberately opened single record, so contact details are shown unmasked
 * here (lists stay masked). Still read-only: no action of any kind.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Transaction · FlexiData" };

const STATUS_SEVERITY: Record<string, AdminSeverity> = {
  successful: "healthy",
  pending: "attention",
  failed: "critical",
  reversed: "unknown",
};

export default async function AdminTransactionDetailPage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  await requireAdmin();

  const { ref } = await params;
  const tx = await loadTransactionDetail(ref);
  if (!tx) notFound();

  return (
    <div className="space-y-4">
      <AdminPageHead
        title={tx.title}
        subtitle={`Reference ${tx.ref}`}
        actions={
          <Link href="/admin/transactions" className="text-[12px] font-semibold opacity-65 hover:opacity-100">
            ← All transactions
          </Link>
        }
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <Panel title="Money" bodyClassName="px-4 py-3">
          <KeyValues
            items={[
              { label: "Amount", value: <MoneyCell amount={tx.amount} /> },
              { label: "Direction", value: tx.direction === "in" ? "Credit (in)" : "Debit (out)" },
              { label: "Points", value: tx.points.toLocaleString("en-GH") },
              { label: "Charged", value: tx.charged ? formatDateTime(tx.chargedAt) : "Not charged" },
              { label: "Fulfilled", value: formatDateTime(tx.fulfilledAt) },
              { label: "Refunded", value: formatDateTime(tx.refundedAt) },
            ]}
          />
        </Panel>

        <Panel title="Status" bodyClassName="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill severity={STATUS_SEVERITY[tx.status] ?? "unknown"}>{tx.status}</StatusPill>
            {tx.fulfillmentStatus && <Badge>{tx.fulfillmentStatus}</Badge>}
          </div>
          <div className="mt-3">
            <KeyValues
              items={[
                { label: "Type", value: <Badge>{tx.type}</Badge> },
                { label: "Network", value: tx.network ?? "—" },
                { label: "Recipient", value: tx.recipient, mono: true },
                { label: "Created", value: formatDateTime(tx.createdAt) },
              ]}
            />
          </div>
        </Panel>

        <Panel title="Parties" bodyClassName="px-4 py-3">
          <KeyValues
            items={[
              {
                label: "Wallet",
                value: (
                  <Link href={`/admin/wallets/${tx.walletId}`} className="hover:underline">
                    #{tx.walletId}
                    {tx.walletNumber ? ` · ${tx.walletNumber}` : ""}
                  </Link>
                ),
              },
              {
                label: "Customer",
                value:
                  tx.userId === null ? (
                    "No linked user"
                  ) : (
                    <Link href={`/admin/users/${tx.userId}`} className="hover:underline">
                      {tx.userName ?? `#${tx.userId}`}
                    </Link>
                  ),
              },
              { label: "Email", value: tx.userEmail },
              { label: "Subtitle", value: tx.subtitle || "—" },
            ]}
          />
        </Panel>
      </div>

      <Panel title="Provider" bodyClassName="px-4 py-3">
        <KeyValues
          items={[
            { label: "Provider", value: tx.provider ?? "None recorded" },
            { label: "Provider reference", value: tx.providerReference ?? "—", mono: true },
            { label: "Provider status", value: tx.providerStatus ?? "—" },
          ]}
        />
        <Note className="mt-3">
          Raw provider payloads are deliberately not displayed: they are free-form responses from an
          external system and may contain data the dashboard has no need to show.
        </Note>
      </Panel>

      <Note>
        Read-only: this transaction cannot be edited, retried, refunded or reversed from the
        dashboard. Amount shown: {adminMoney(tx.amount)}.
      </Note>
    </div>
  );
}
