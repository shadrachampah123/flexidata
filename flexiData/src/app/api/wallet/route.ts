import { requireAccount } from "@/lib/api-auth";
import { toWalletDTO, WalletNotFoundError } from "@/lib/data";
import { isMissingRelationError } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's own wallet summary (balance, points, number) — the
 * freshness signal the client-side wallet guard polls (see
 * `src/components/wallet-freshness.tsx`).
 *
 * Why this exists: the Wallet page itself is a `force-dynamic` Server
 * Component that reads the balance straight from the database, but the
 * browser's client-side Router Cache can still serve a previously-rendered
 * RSC payload for /wallet (and /) for a short window after they were last
 * visited. Money can also move OUT OF BAND — an admin rejecting/refunding a
 * withdrawal, a Paystack webhook settling a deposit, an incoming transfer —
 * none of which can invalidate a cache that lives in *another* browser.
 *
 * This endpoint is the one source the client can always trust:
 *  - it is scoped to the signed-in owner via `requireAccount()` (a wallet that
 *    is not the caller's own can never be read here);
 *  - it is answered with `Cache-Control: no-store` so neither the browser
 *    HTTP cache nor any intermediary may hold it;
 *  - it only exposes fields the Wallet page already renders (no email, no
 *    admin fields, no ledger).
 */
export async function GET() {
  let auth: Awaited<ReturnType<typeof requireAccount>>;
  try {
    auth = await requireAccount();
  } catch (error) {
    // An account without a wallet row has nothing to report (same answer the
    // wallet page would give); a database still awaiting its migration gets
    // the schema-upgrade answer instead of a bare 500.
    if (error instanceof WalletNotFoundError) {
      return Response.json({ ok: false, error: "Wallet not found" }, { status: 404 });
    }
    if (isMissingRelationError(error)) {
      return Response.json(
        { ok: false, error: "Wallet data is being upgraded. Please try again shortly.", code: "schema_out_of_date" },
        { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }
    console.error("[flexidata] wallet summary failed", error);
    return Response.json({ ok: false, error: "Could not load wallet" }, { status: 500 });
  }
  if (!auth.ok) return auth.response;

  const wallet = toWalletDTO(auth.wallet);
  return Response.json(
    {
      ok: true,
      wallet: {
        id: wallet.id,
        number: wallet.number,
        balance: wallet.balance,
        points: wallet.points,
      },
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}
