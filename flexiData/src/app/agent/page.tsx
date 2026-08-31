import { getAgentProfile } from "@/lib/data";
import { Agent } from "@/components/agent";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AgentPage() {
  const { wallet } = await requireSession();
  const profile = await getAgentProfile(wallet.id);
  return (
    <div>
      <PageHeader
        title="Agent Program"
        subtitle={profile ? "Your sub-agent portal" : "Sell data. Earn daily."}
        balance={wallet.balance}
      />
      <Agent wallet={wallet} profile={profile} />
    </div>
  );
}
