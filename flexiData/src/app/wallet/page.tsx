import { WalletTools } from "@/components/wallet-tools";
import { PageHeader } from "@/components/page-header";
import { paymentsProvider, PaystackConfigError } from "@/lib/payments";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; funding?: string; ref?: string }>;
}) {
  const { wallet } = await requireSession();
  const sp = await searchParams;
  const initialTab = sp.tab === "transfer" ? "transfer" : "fund";
  const funding = sp.funding === "success" ? sp.ref ?? null : null;
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
  return (
    <div>
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
      />
    </div>
  );
}
