import { getAgentProfile, getWallet } from "@/lib/data";
import { Agent } from "@/components/agent";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";

export default async function AgentPage() {
  const [wallet, profile] = await Promise.all([getWallet(), getAgentProfile()]);
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
