import { getWallet } from "@/lib/data";
import { BuyAirtime } from "@/components/buy-airtime";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

export default async function AirtimePage() {
  const wallet = await getWallet();
  return (
    <div>
      <PageHeader
        title="Buy Airtime"
        subtitle="2% off every top-up, delivered instantly"
        balance={wallet.balance}
      />
      <BuyAirtime wallet={wallet} />
    </div>
  );
}
