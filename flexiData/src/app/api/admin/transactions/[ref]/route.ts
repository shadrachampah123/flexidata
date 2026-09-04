import { requireAdminApi } from "@/lib/admin/auth";
import { loadTransactionDetail } from "@/lib/admin/queries-operations";
import { adminError, adminJson } from "@/lib/admin/api";

/**
 * `GET /api/admin/transactions/[ref]` — one ledger row, unmasked, for the
 * deliberately-opened single-record view. Read-only.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const { ref } = await params;
  if (!ref) return adminJson({ ok: false, error: "Missing reference" }, 400);

  try {
    const transaction = await loadTransactionDetail(ref);
    if (!transaction) return adminJson({ ok: false, error: "Transaction not found" }, 404);
    return adminJson({ ok: true, transaction });
  } catch (error) {
    return adminError("transaction detail", error);
  }
}
