import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/auth";
import { loadUserDetail } from "@/lib/admin/queries";
import { AdminPageHead } from "@/components/admin/page-head";
import { Badge, KeyValues, MoneyCell, Note, Panel, StatusPill } from "@/components/admin/ui";
import { adminMoney, formatDateTime } from "@/lib/admin/format";

/**
 * `/admin/users/[id]` — one customer, read-only.
 *
 * This is the deliberately opened single-record view, so the real email and
 * phone are shown (lists stay masked) and the recent session trail is included:
 * an operator investigating a disputed account needs the login history, and it
 * is one account at a time rather than a bulk list.
 *
 * Nothing here modifies the user: no reset, no suspension, no role change, no
 * deletion.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Customer · FlexiData" };

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();

  const { id } = await params;
  const userId = Number(id);
  if (!Number.isInteger(userId) || userId <= 0) notFound();

  const detail = await loadUserDetail(userId);
  if (!detail) notFound();

  const { user, wallets, sessions, recentTransactions, recentOrders, totals } = detail;
  const primaryWallet = wallets[0];

  return (
    <div className="space-y-4">
      <AdminPageHead
        title={user.name}
        subtitle={`Customer #${user.userId} · joined ${formatDateTime(user.createdAt)}`}
        actions={
          <Link href="/admin/users" className="text-[12px] font-semibold opacity-65 hover:opacity-100">
            ← All customers
          </Link>
        }
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <Panel title="Identity" bodyClassName="px-4 py-3">
          <KeyValues
            items={[
              { label: "User ID", value: `#${user.userId}`, mono: true },
              { label: "Email", value: user.email },
              { label: "Phone", value: user.phone, mono: true },
              { label: "Email verified", value: formatDateTime(user.emailVerifiedAt) },
              { label: "Referral code", value: user.referralCode ?? "—", mono: true },
              {
                label: "Referred by",
                value: user.referredBy === null ? "—" : `#${user.referredBy}`,
              },
              { label: "Referral rewarded", value: formatDateTime(user.referralRewardedAt) },
              { label: "Notifications", value: `${user.notifyPromos ? "promos" : "no promos"} · ${user.notifyTx ? "tx" : "no tx"}` },
              { label: "Updated", value: formatDateTime(user.updatedAt) },
            ]}
          />
        </Panel>

        <Panel title="Account status" bodyClassName="px-4 py-3">
          <div className="mb-3 flex flex-wrap gap-1.5">
            <StatusPill severity={user.isAdmin ? "attention" : "healthy"}>
              {user.isAdmin ? "Administrator" : "Standard account"}
            </StatusPill>
            <StatusPill severity={wallets.length === 1 ? "healthy" : wallets.length === 0 ? "critical" : "attention"}>
              {wallets.length === 1 ? "One wallet" : wallets.length === 0 ? "No wallet" : `${wallets.length} wallets`}
            </StatusPill>
            <StatusPill severity={user.emailVerifiedAt ? "healthy" : "attention"}>
              {user.emailVerifiedAt ? "Email verified" : "Email unverified"}
            </StatusPill>
          </div>
          <KeyValues
            items={[
              {
                label: "Successful deposits",
                value:
                  totals.successfulDeposits === null
                    ? "Not available"
                    : `${totals.successfulDeposits} · ${adminMoney(totals.successfulDepositValue ?? 0)}`,
              },
              {
                label: "Successful purchases",
                value:
                  totals.successfulPurchases === null
                    ? "Not available"
                    : `${totals.successfulPurchases} · ${adminMoney(totals.successfulPurchaseValue ?? 0)}`,
              },
              {
                label: "Failed deliveries",
                value: totals.failedDeliveries === null ? "Not available" : String(totals.failedDeliveries),
              },
              {
                label: "Active sessions",
                value: String(sessions.filter((session) => !session.expired).length),
              },
            ]}
          />
          {wallets.length > 1 && (
            <Note className="mt-3">
              This customer has more than one wallet. That is a reconciliation finding to review, not
              something the dashboard repairs — the customer app itself only ever reads one of them.
            </Note>
          )}
        </Panel>

        <Panel title="Wallets" bodyClassName="px-4 py-3">
          {wallets.length === 0 ? (
            <Note>No wallet is linked to this account.</Note>
          ) : (
            <ul className="space-y-2">
              {wallets.map((wallet) => (
                <li
                  key={wallet.walletId}
                  className="rounded-xl border border-black/[0.06] px-3 py-2 dark:border-line"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={`/admin/wallets/${wallet.walletId}`}
                      className="font-mono text-[12px] font-semibold text-brand-deep hover:underline dark:text-brand"
                    >
                      #{wallet.walletId} · {wallet.walletNumber}
                    </Link>
                    <MoneyCell amount={wallet.balance} />
                  </div>
                  <p className="mt-1 text-[11px] opacity-60">
                    {wallet.points.toLocaleString("en-GH")} points
                    {wallet.isAgent ? ` · agent ${wallet.agentTier ?? ""}` : ""} · created{" "}
                    {formatDateTime(wallet.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {primaryWallet && (
            <Link
              href={`/admin/transactions?walletId=${primaryWallet.walletId}`}
              className="mt-3 inline-block text-[12px] font-semibold text-brand-deep hover:underline dark:text-brand"
            >
              View ledger for wallet #{primaryWallet.walletId}
            </Link>
          )}
        </Panel>
      </div>

      <Panel
        title="Recent transactions"
        subtitle="Ten most recent ledger rows across this customer's wallets."
        bodyClassName="px-0 py-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-black/[0.06] bg-black/[0.015] text-[10px] uppercase tracking-[0.1em] text-zinc-500 dark:border-line dark:bg-white/[0.02]">
                <th className="px-3 py-2.5">Reference</th>
                <th className="px-3 py-2.5">Created</th>
                <th className="px-3 py-2.5">Type</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.04] dark:divide-white/[0.05]">
              {recentTransactions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-[13px] opacity-55">
                    No ledger activity yet.
                  </td>
                </tr>
              ) : (
                recentTransactions.map((tx) => (
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
                    <td className="px-3 py-2.5 text-[12px] capitalize">{tx.status}</td>
                    <td className="px-3 py-2.5 text-right">
                      <MoneyCell amount={tx.amount} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="Recent data purchases"
          subtitle="Paystack checkout orders placed by this customer."
          bodyClassName="px-0 py-0"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-black/[0.06] bg-black/[0.015] text-[10px] uppercase tracking-[0.1em] text-zinc-500 dark:border-line dark:bg-white/[0.02]">
                  <th className="px-3 py-2.5">Order</th>
                  <th className="px-3 py-2.5">Bundle</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[0.04] dark:divide-white/[0.05]">
                {recentOrders.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-[13px] opacity-55">
                      No checkout orders yet.
                    </td>
                  </tr>
                ) : (
                  recentOrders.map((order) => (
                    <tr key={order.id}>
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/admin/transactions/${encodeURIComponent(order.ref)}`}
                          className="font-mono text-[12px] font-semibold text-brand-deep hover:underline dark:text-brand"
                        >
                          {order.ref}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-[12px]">
                        {order.bundle}
                        <div className="opacity-55">{order.phone}</div>
                      </td>
                      <td className="px-3 py-2.5 text-[12px]">{order.delivery}</td>
                      <td className="px-3 py-2.5 text-right">
                        <MoneyCell amount={order.amount} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          title="Recent sessions"
          subtitle="Five most recently seen sessions. Useful when investigating a disputed account."
          bodyClassName="px-4 py-3"
        >
          {sessions.length === 0 ? (
            <Note>No sessions recorded for this account.</Note>
          ) : (
            <ul className="space-y-2">
              {sessions.map((session) => (
                <li
                  key={session.sessionId}
                  className="rounded-xl border border-black/[0.06] px-3 py-2 text-[12px] dark:border-line"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono">#{session.sessionId}</span>
                    <StatusPill severity={session.expired ? "unknown" : "healthy"}>
                      {session.expired ? "Expired" : "Active"}
                    </StatusPill>
                  </div>
                  <p className="mt-1 opacity-60">
                    Last seen {formatDateTime(session.lastSeenAt)} · expires{" "}
                    {formatDateTime(session.expiresAt)}
                  </p>
                  <p className="mt-0.5 break-all opacity-60">
                    {session.ip ?? "IP not recorded"}
                    {session.userAgent ? ` · ${session.userAgent}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Note>
        Read-only customer view. Accounts cannot be edited, suspended, promoted, password-reset or
        deleted from the dashboard.
      </Note>
    </div>
  );
}
