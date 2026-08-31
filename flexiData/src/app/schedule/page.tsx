import { getPlans, getSchedules } from "@/lib/data";
import { Schedule } from "@/components/schedule";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const { wallet } = await requireSession();
  const [schedules, plans] = await Promise.all([getSchedules(wallet.id), getPlans()]);
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
