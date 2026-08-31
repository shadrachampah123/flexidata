import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentProfiles, wallets } from "@/db/schema";
import { requireAccount } from "@/lib/api-auth";
import { makeReferralCode } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;
    const { wallet } = auth;

    const existing = await db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.walletId, wallet.id))
      .limit(1);

    if (existing[0] && wallet.isAgent) {
      return Response.json({
        ok: true,
        profile: {
          tier: existing[0].tier,
          referralCode: existing[0].referralCode,
          referrals: existing[0].referrals,
          commission: Number(existing[0].commission),
          volume: Number(existing[0].volume),
        },
        balance: Number(wallet.balance),
      });
    }

    const referralCode = wallet.referralCode ?? `FD${makeReferralCode()}`;
    // Activate the pre-created agent slot (created at registration).
    await db
      .update(agentProfiles)
      .set({ referralCode, tier: "Starter" })
      .where(eq(agentProfiles.walletId, wallet.id));
    await db
      .update(wallets)
      .set({ isAgent: true, agentTier: "Starter", referralCode })
      .where(eq(wallets.id, wallet.id));

    return Response.json({
      ok: true,
      profile: { tier: "Starter", referralCode, referrals: 0, commission: 0, volume: 0 },
    });
  } catch (e) {
    console.error("agent register error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
