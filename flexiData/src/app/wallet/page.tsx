import { getWallet } from "@/lib/data";
import { WalletTools } from "@/components/wallet-tools";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const [wallet, sp] = await Promise.all([getWallet(), searchParams]);
  const initialTab = sp.tab === "transfer" ? "transfer" : "fund";
  return (
    <div>
      <PageHeader
        title="Wallet"
        subtitle="Fund, transfer & manage your money"
        balance={wallet.balance}
      />
      <WalletTools wallet={wallet} initialTab={initialTab} />
    </div>
  );
}
