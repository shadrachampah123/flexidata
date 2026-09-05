import { getCurrentUser } from "@/lib/auth";
import { getWalletRowForUser, type WalletRow } from "@/lib/data";

/**
 * Resolve the signed-in user + their wallet for an API route. Returns either
 * the context handlers need or a JSON Response the caller can return
 * directly. Keeps every money-moving route on the real account instead of a
 * shared demo wallet.
 *
 * Suspended accounts (Phase 2, Step 1) resolve their identity normally — they
 * can still read their own data — but every *action* route that goes through
 * here is refused with a 403. The wallet balance, deposits and ledger are never
 * touched on the refusal path.
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
  if (user.suspended) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: "This account is suspended. Contact support for help.",
          code: "account_suspended",
        },
        { status: 403, headers: { "Cache-Control": "no-store, max-age=0" } },
      ),
    };
  }
  const wallet = await getWalletRowForUser(user.id);
  return { ok: true, userId: user.id, wallet };
}
