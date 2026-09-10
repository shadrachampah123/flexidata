import { WalletTools } from "@/components/wallet-tools";
import { WalletFreshness } from "@/components/wallet-freshness";
import { PageHeader } from "@/components/page-header";
import { paymentsProvider, PaystackConfigError } from "@/lib/payments";
import { getRecentWithdrawals } from "@/lib/data";
import { requireSession } from "@/lib/session";
import { isWithdrawalsEnabled } from "@/lib/withdrawal-flag";

export const dynamic = "force-dynamic";

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; funding?: string; ref?: string }>;
}) {
  const { wallet } = await requireSession();
  const sp = await searchParams;
  const initialTab = sp.tab === "transfer" ? "transfer" : sp.tab === "withdraw" ? "withdraw" : "fund";
  const funding = sp.funding === "success" ? sp.ref ?? null : null;
  // The withdrawal history is read from the `withdrawal_requests` table. Follow
  // the app's degrade-around-a-lagging-schema rule: if that table isn't in the
  // database yet, the wallet page still renders (with the Withdraw tab) rather
  // than taking funding/transfers/history down with it.
  let withdrawals: Awaited<ReturnType<typeof getRecentWithdrawals>> = [];
  try {
    withdrawals = await getRecentWithdrawals(wallet.id);
  } catch {
    withdrawals = [];
  }
  // Resolved server-side so the funding UI describes the gateway that will
  // really be used (Paystack checkout vs the opt-in local simulator). The
  // client never decides this, and no key material is involved.
  //
  // A production funding lockout (PAYMENTS_PROVIDER=mock, or no Paystack key)
  // does not take the whole wallet page down: funding is rendered as
  // "unavailable" — and the WalletTools production build hard-disables every
  // demo top-up control — while transfers still work. Fail closed, not down.
  let fundingProvider: "paystack" | "mock" | "unavailable" = "paystack";
  try {
    fundingProvider = paymentsProvider();
  } catch (error) {
    if (!(error instanceof PaystackConfigError)) throw error;
    fundingProvider = "unavailable";
  }
  // Temporary withdrawal kill switch, resolved server-side (fail-closed: only
  // an explicit WITHDRAWALS_ENABLED=true enables). Passed down as a plain
  // boolean — the client never reads the flag itself, and the withdraw API
  // enforces the same switch independently of whatever the UI renders.
  const withdrawalsEnabled = isWithdrawalsEnabled();
  return (
    <div>
      {/* Money surface: revalidate against the live balance when the page
          (re)appears, so out-of-band mutations (admin rejection refunds,
          webhook deposit settlements, incoming transfers) are reflected
          without a reload. Renders nothing. */}
      <WalletFreshness serverBalance={wallet.balance} />
      <PageHeader
        title="Wallet"
        subtitle="Fund, transfer & manage your money"
        balance={wallet.balance}
      />
      <WalletTools
        wallet={wallet}
        initialTab={initialTab}
        pendingFundingRef={funding}
        fundingProvider={fundingProvider}
        withdrawals={withdrawals}
        withdrawalsEnabled={withdrawalsEnabled}
      />
    </div>
  );
}
