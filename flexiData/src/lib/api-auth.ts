import { getCurrentUser } from "@/lib/auth";
import { getWalletRowForUser, type WalletRow } from "@/lib/data";

/**
 * Resolve the signed-in user + their wallet for an API route. Returns either
 * the context handlers need or a JSON 401 Response the caller can return
 * directly. Keeps every money-moving route on the real account instead of a
 * shared demo wallet.
 */
export async function requireAccount(): Promise<
  | { ok: true; userId: number; wallet: WalletRow }
  | { ok: false; response: Response }
> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: "Please sign in to continue", code: "unauthenticated" },
        { status: 401 },
      ),
    };
  }
  const wallet = await getWalletRowForUser(user.id);
  return { ok: true, userId: user.id, wallet };
}
