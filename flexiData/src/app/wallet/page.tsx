import { WalletTools } from "@/components/wallet-tools";
import { PageHeader } from "@/components/page-header";
import { paymentsProvider } from "@/lib/payments";
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
  const fundingProvider = paymentsProvider();
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
