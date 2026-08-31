import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentProfiles, wallets } from "@/db/schema";
import { getWalletRow } from "@/lib/data";
import { makeReferralCode } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const wallet = await getWalletRow();

    const existing = await db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.walletId, wallet.id))
      .limit(1);

    if (existing[0]) {
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

    const referralCode = `FD${makeReferralCode()}`;
    await db.insert(agentProfiles).values({
      walletId: wallet.id,
      tier: "Starter",
      referralCode,
    });
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
