import { getPlans, getSchedules, getWallet } from "@/lib/data";
import { Schedule } from "@/components/schedule";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const [wallet, schedules, plans] = await Promise.all([getWallet(), getSchedules(), getPlans()]);
  return (
    <div>
      <PageHeader
        title="Auto Top-up"
        subtitle="Recurring bundles on your schedule"
        balance={wallet.balance}
      />
      <Schedule schedules={schedules} plans={plans} />
    </div>
  );
}
