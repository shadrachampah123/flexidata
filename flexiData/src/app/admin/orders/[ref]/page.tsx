import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/auth";
import { parseRef } from "@/lib/admin/filters";
import { loadOrderInvestigation } from "@/lib/admin/queries-investigation";
import { AdminPageHead } from "@/components/admin/page-head";
import { Badge, MoneyCell, Note, Panel, StatusPill } from "@/components/admin/ui";
import {
  DeliveryTimeline,
  FactsPanel,
  FindingsPanel,
  RecordedActionsPanel,
  SupportWorkflowLink,
  VerdictBanner,
} from "@/components/admin/investigation";
import { PaystackStatusProbe } from "@/components/admin/paystack-probe";
import { adminMoney, formatDateTime } from "@/lib/admin/format";

/**
 * `/admin/orders/[ref]` — one Paystack checkout order, investigated in full.
 *
 * Phase 2, Step 3 (S3.1). This page exists because the drill-down from Data
 * operations and Requires support pointed at the LEDGER view, which has no row
 * for an order that never reached the provider submit path — so the parked,
 * in-flight and mismatch-parked orders an operator most needs to inspect were a
 * 404 dead end.
 *
 * It is a read. Everything rendered here comes from `loadOrderInvestigation()`
 * inside a `SET TRANSACTION READ ONLY` transaction, and every judgement is the
 * pure classifier in `src/lib/admin/diagnosis.ts` applied to those facts. There
 * is no control on this page that can change an order, a payment, a wallet, a
 * ledger row or a delivery:
 *
 *  - the money columns are DISPLAYED, with the pesewa figure called out as the
 *    authoritative one;
 *  - the provider columns are shown exactly as last reported and are never
 *    rewritten (an admin-confirmed delivery says so, and the audit trail below
 *    names who confirmed it);
 *  - the only interactive element is the read-only Paystack status probe, which
 *    asks the gateway a question and persists nothing;
 *  - acting on the order still happens in exactly one place — the audited Step 2
 *    support workflow on `/admin/attention`, linked from here rather than
 *    duplicated.
 *
 * Raw `provider_payload` / `provider_response` jsonb is never selected, so no
 * free-form external blob reaches this screen.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Order · FlexiData" };

export default async function AdminOrderInvestigationPage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  await requireAdmin();

  const { ref } = await params;
  const orderRef = parseRef(ref);
  if (!orderRef) notFound();

  const result = await loadOrderInvestigation(orderRef);
  if (!result) notFound();

  const { order, mirror, tracking, findings, verdict } = result;

  return (
    <div className="space-y-4">
      <AdminPageHead
        title={`Order ${order.ref}`}
        subtitle={`${order.network ?? "—"} ${order.planLabel ?? ""} · ${order.category ?? ""} · recipient ${order.recipient}`}
        actions={
          <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold opacity-65">
            <Link href="/admin/data" className="hover:opacity-100">
              ← Data operations
            </Link>
            <Link href="/admin/attention" className="hover:opacity-100">
              Requires support
            </Link>
            {order.userId && (
              <Link href={`/admin/users/${order.userId}`} className="hover:opacity-100">
                Customer
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
              <Badge tone="mono">order_status: {order.orderStatus}</Badge>
              <Badge tone="mono">payment_status: {order.paymentStatus}</Badge>
              <Badge tone="mono">fulfillment: {order.fulfillmentStatus ?? "—"}</Badge>
              {order.accountStatus === "suspended" && (
                <StatusPill severity="attention">Customer suspended</StatusPill>
              )}
            </div>
          }
        />
        <div className="mt-3 border-t border-black/[0.05] pt-2 dark:border-line">
          <SupportWorkflowLink orderRef={order.ref} actionable={order.supportActionable} />
        </div>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-3">
        <FactsPanel
          title="Money (display only)"
          subtitle="The values Paystack and the provider last wrote. No control on this page can change them."
          items={[
            { label: "Amount", value: <MoneyCell amount={order.amount} /> },
            {
              label: "Pesewas charged (authoritative)",
              value: order.amountSubunits === null ? "Not recorded" : order.amountSubunits.toLocaleString("en-GH"),
              mono: true,
            },
            { label: "Currency", value: order.currency },
            { label: "Payment status", value: order.paymentStatus },
            { label: "Paid at", value: formatDateTime(order.paidAt) },
            { label: "Verified at", value: formatDateTime(order.verifiedAt) },
          ]}
        />

        <FactsPanel
          title="Paystack trail"
          subtitle="Stored audit columns only — never key material, never a raw payload."
          items={[
            { label: "Transaction id", value: order.paystackTransactionId ?? "—", mono: true },
            { label: "Channel", value: order.paystackChannel ?? "—" },
            { label: "Gateway response", value: order.paystackGatewayResponse ?? "—" },
            { label: "Our reference", value: order.ref, mono: true },
          ]}
        />

        <FactsPanel
          title="Data provider trail"
          subtitle="Exactly as the provider last reported. This dashboard never rewrites a provider field."
          items={[
            { label: "Provider reference", value: order.providerReference ?? "—", mono: true },
            { label: "Provider status", value: order.providerStatus ?? "—" },
            { label: "Provider message", value: order.providerMessage ?? "—" },
            { label: "Product code", value: order.providerProductCode ?? "—", mono: true },
            { label: "Failed at", value: formatDateTime(order.failedAt) },
            { label: "Fulfilled at", value: formatDateTime(order.fulfilledAt) },
          ]}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <Panel
            title="Ledger mirror"
            subtitle="The `transactions` row the checkout flow writes so history and tracking work. The wallet is never debited for a Paystack order."
            bodyClassName="px-4 py-3"
          >
            {mirror ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/admin/transactions/${encodeURIComponent(mirror.ref)}`}
                    className="font-mono text-[12px] font-semibold text-brand-deep hover:underline dark:text-brand"
                  >
                    {mirror.ref}
                  </Link>
                  <Badge tone="mono">status: {mirror.status}</Badge>
                  <Badge tone="mono">direction: {mirror.direction}</Badge>
                  {mirror.fulfillmentStatus && <Badge tone="mono">{mirror.fulfillmentStatus}</Badge>}
                </div>
                <p className="text-[12px] opacity-70">
                  {mirror.title} · <span className="font-semibold">{adminMoney(mirror.amount)}</span> ·{" "}
                  {mirror.points.toLocaleString("en-GH")} points · wallet #{mirror.walletId}
                </p>
                <p className="text-[11px] opacity-55">
                  charged {formatDateTime(mirror.chargedAt)} · fulfilled {formatDateTime(mirror.fulfilledAt)} ·
                  refunded {formatDateTime(mirror.refundedAt)} · created {formatDateTime(mirror.createdAt)}
                </p>
              </div>
            ) : (
              <Note>
                No ledger row carries this reference. The checkout flow writes the mirror only once the
                provider submit path runs, so an order parked before that point — or one still awaiting
                payment — has none. This is a fact about the record, not an error, and it is why the
                timeline here is derived from the order row.
              </Note>
            )}
          </Panel>

          <FindingsPanel findings={findings} />

          <PaystackStatusProbe
            endpoint={`/api/admin/orders/${encodeURIComponent(order.ref)}/paystack-status`}
            available={result.probe.available}
            mode={result.probe.mode}
            reason={result.probe.reason}
            subjectLabel={`order ${order.ref}`}
          />
        </div>

        <div className="space-y-3">
          <DeliveryTimeline
            phase={tracking.phase}
            progress={tracking.progress}
            etaLabel={tracking.etaLabel}
            overdue={tracking.overdue}
            stages={tracking.stages}
          />

          <FactsPanel
            title="Customer"
            items={[
              { label: "Name", value: order.customerName ?? "—" },
              { label: "Email", value: order.customerEmail },
              { label: "Phone", value: order.customerPhone },
              {
                label: "Account",
                value:
                  order.userId === null ? (
                    "No linked account"
                  ) : (
                    <Link href={`/admin/users/${order.userId}`} className="font-semibold hover:underline">
                      #{order.userId}
                    </Link>
                  ),
              },
              {
                label: "Wallet",
                value:
                  order.walletId === null ? (
                    "—"
                  ) : (
                    <Link href={`/admin/wallets/${order.walletId}`} className="font-semibold hover:underline">
                      #{order.walletId} {order.walletNumber ? `(${order.walletNumber})` : ""}
                    </Link>
                  ),
              },
              { label: "Account status", value: order.accountStatus ?? "Not available" },
            ]}
          />

          <FactsPanel
            title="Timestamps"
            items={[
              { label: "Created", value: formatDateTime(order.createdAt) },
              { label: "Updated", value: formatDateTime(order.updatedAt) },
              { label: "Abandoned", value: formatDateTime(order.abandonedAt) },
            ]}
          />

          <RecordedActionsPanel
            title="Admin actions on this order"
            actions={result.recordedActions}
            available={result.refTrailAvailable}
            emptyLabel="No administrator has recorded an action against this order reference."
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
