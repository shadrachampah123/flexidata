import { requireAdminApi } from "@/lib/admin/auth";
import { loadWalletDetail } from "@/lib/admin/queries";
import { adminError, adminJson, pageParam, pageSizeParam, searchParamsOf } from "@/lib/admin/api";

/**
 * `GET /api/admin/wallets/[id]` — one wallet, stored vs calculated, plus the
 * ledger rows that fed the calculation. Read-only: the response explicitly
 * labels the calculated figure as diagnostic so it can never be mistaken for
 * the authoritative balance.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const walletId = Number(id);
  if (!Number.isInteger(walletId) || walletId <= 0) {
    return adminJson({ ok: false, error: "Invalid wallet id" }, 400);
  }

  try {
    const query = searchParamsOf(request);
    const detail = await loadWalletDetail(walletId, pageParam(query), pageSizeParam(query));
    if (!detail) return adminJson({ ok: false, error: "Wallet not found" }, 404);
    return adminJson({ ok: true, ...detail });
  } catch (error) {
    return adminError("wallet detail", error);
  }
}
