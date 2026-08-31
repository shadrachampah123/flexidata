import { REDEEM_OPTIONS } from "@/lib/constants";
import { Rewards } from "@/components/rewards";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function RewardsPage() {
  const { wallet } = await requireSession();
  return (
    <div>
      <PageHeader title="Rewards" subtitle="Earn points on every purchase" balance={wallet.balance} />
      <Rewards wallet={wallet} options={REDEEM_OPTIONS} />
    </div>
  );
}
