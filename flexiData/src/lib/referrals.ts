import type { PoolClient } from "pg";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { users, wallets } from "@/db/schema";
import { insertTransactionRow } from "@/lib/data";
import { makeRef } from "@/lib/format";

/**
 * Referral reward: when a referred user completes their first successful
 * paid action, the referrer earns a points bonus (like DataPlug's referral
 * commissions / MyDataBundle's referral programme). Credited exactly once per
 * referred user.
 */
const REFERRAL_POINTS = 150;

export async function creditReferralReward(userId: number, walletId: number, client?: PoolClient): Promise<void> {
  // Durable purchase settlement supplies its existing transaction. Keep the
  // same reward claim + ledger rather than creating parallel reward accounting.
  if (client) {
    const marked = await client.query(`UPDATE users SET referral_rewarded_at=now()
      WHERE id=$1 AND referred_by IS NOT NULL AND referral_rewarded_at IS NULL
      AND EXISTS (SELECT 1 FROM wallets WHERE user_id=users.referred_by)
      RETURNING referred_by`, [userId]);
    if (!marked.rows[0]) return;
    const reward = await client.query(`UPDATE wallets SET points=points+$2 WHERE id=(
      SELECT id FROM wallets WHERE user_id=$1 ORDER BY id LIMIT 1) RETURNING id`, [marked.rows[0].referred_by, REFERRAL_POINTS]);
    await client.query(`INSERT INTO transactions (ref,wallet_id,type,status,direction,title,subtitle,amount,points)
      VALUES ($1,$2,'referral','successful','in','Referral Bonus',$3,0,$4)`,
    [makeRef("RF"), reward.rows[0].id, `${REFERRAL_POINTS} points earned from a friend's first purchase`, REFERRAL_POINTS]);
    return;
  }
  const rows = await db
    .select({
      id: users.id,
      referredBy: users.referredBy,
      referralRewardedAt: users.referralRewardedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user || !user.referredBy || user.referralRewardedAt) return;

  // Mark rewarded first (idempotent under concurrent requests).
  const marked = await db
    .update(users)
    .set({ referralRewardedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.referralRewardedAt)))
    .returning({ id: users.id });
  if (!marked[0]) return;

  const referrerWallets = await db
    .select({ id: wallets.id, points: wallets.points })
    .from(wallets)
    .where(eq(wallets.userId, user.referredBy))
    .limit(1);
  const referrerWallet = referrerWallets[0];
  if (!referrerWallet) return;

  await db
    .update(wallets)
    .set({ points: referrerWallet.points + REFERRAL_POINTS })
    .where(eq(wallets.id, referrerWallet.id));

  await insertTransactionRow({
    ref: makeRef("RF"),
    walletId: referrerWallet.id,
    type: "referral",
    status: "successful",
    direction: "in",
    title: "Referral Bonus",
    subtitle: `${REFERRAL_POINTS} points earned from a friend's first purchase`,
    amount: "0.00",
    points: REFERRAL_POINTS,
    network: null,
    recipient: null,
  });
}
