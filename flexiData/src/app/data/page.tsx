import { getPlans } from "@/lib/data";
import { getDataProviderCode, isTechlinkProviderCode } from "@/lib/data-gateway";
import { BUNDLE_CATEGORIES } from "@/lib/constants";
import { BuyData } from "@/components/buy-data";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DataPage() {
  const [{ wallet }, plans] = await Promise.all([requireSession(), getPlans()]);
  const liveCatalogue = isTechlinkProviderCode(getDataProviderCode());
  return (
    <div>
      <PageHeader
        title="Buy Data"
        subtitle="Discounted MTN & Telecel bundles"
        balance={wallet.balance}
      />
      <BuyData
        wallet={wallet}
        plans={plans}
        categories={BUNDLE_CATEGORIES}
        liveCatalogue={liveCatalogue}
      />
    </div>
  );
}
