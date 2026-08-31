import { Convert } from "@/components/convert";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ConvertPage() {
  const { wallet } = await requireSession();
  return (
    <div>
      <PageHeader
        title="Airtime to Cash"
        subtitle="Turn airtime into wallet cash in seconds"
        balance={wallet.balance}
      />
      <Convert wallet={wallet} />
    </div>
  );
}
