import { getPlans } from "@/lib/data";
import { BUNDLE_CATEGORIES } from "@/lib/constants";
import { BuyData } from "@/components/buy-data";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DataPage() {
  const [{ wallet }, plans] = await Promise.all([requireSession(), getPlans()]);
  return (
    <div>
      <PageHeader
        title="Buy Data"
        subtitle="Discounted MTN & Telecel bundles"
        balance={wallet.balance}
      />
      <BuyData wallet={wallet} plans={plans} categories={BUNDLE_CATEGORIES} />
    </div>
  );
}
