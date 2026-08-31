import { PageHeader } from "@/components/page-header";
import { SettingsPanel } from "@/components/settings-panel";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user, wallet } = await requireSession();
  return (
    <div>
      <PageHeader title="Settings" subtitle="Manage your account & security" balance={wallet.balance} />
      <SettingsPanel
        user={{
          name: user.name,
          email: user.email,
          phone: user.phone,
          referralCode: user.referralCode,
          notifyPromos: user.notifyPromos,
          notifyTx: user.notifyTx,
        }}
      />
    </div>
  );
}
