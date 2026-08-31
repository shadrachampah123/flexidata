import { getAllTransactions, getWallet } from "@/lib/data";
import { History } from "@/components/history";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const [wallet, txs] = await Promise.all([getWallet(), getAllTransactions()]);
  return (
    <div>
      <PageHeader title="Transaction History" subtitle="Your complete ledger" balance={wallet.balance} />
      <History txs={txs} />
    </div>
  );
}
