import { getCurrentUser } from "@/lib/auth";
import { getWalletRowForUser } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ ok: false, authenticated: false }, { status: 401 });
  }
  let balance: number | null = null;
  let points = 0;
  try {
    const wallet = await getWalletRowForUser(user.id);
    balance = Number(wallet.balance);
    points = wallet.points;
  } catch {
    // Wallet is created at registration; ignore edge races.
  }
  return Response.json({
    ok: true,
    authenticated: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      referralCode: user.referralCode,
      isAgent: user.isAgent,
      notifyPromos: user.notifyPromos,
      notifyTx: user.notifyTx,
      balance,
      points,
    },
  });
}
