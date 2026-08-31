import { getAllTransactions } from "@/lib/data";
import { History } from "@/components/history";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const { wallet } = await requireSession();
  const txs = await getAllTransactions(wallet.id);
  return (
    <div>
      <PageHeader title="Transaction History" subtitle="Your complete ledger" balance={wallet.balance} />
      <History txs={txs} />
    </div>
  );
}
