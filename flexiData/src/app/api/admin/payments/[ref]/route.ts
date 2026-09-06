import { requireAdminApi } from "@/lib/admin/auth";
import { adminError, adminJson } from "@/lib/admin/api";
import { parseRef } from "@/lib/admin/filters";
import { loadDepositDetail } from "@/lib/admin/queries-investigation";

/**
 * `GET /api/admin/payments/[ref]` — one wallet funding attempt in full.
 *
 * Phase 2, Step 3 (S3.3). The payments list previously linked a reference back
 * to a filtered view of itself, so a deposit parked by the Paystack
 * verification-mismatch guard — the "customer says they paid" case — had no
 * record view at all.
 *
 * Read-only, inside `withReadOnlyTx`. It reports the stored deposit, the ledger
 * rows carrying its reference, and the owning wallet's stored-vs-calculated
 * verdict computed with the SAME rule the reconciliation screen uses, so the
 * two can never disagree. It never settles the deposit: `reconcileDeposit()` is
 * not imported and is not reachable from here — the customer's own verify path
 * remains the only code that can credit a wallet.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const { ref } = await params;
  const depositRef = parseRef(ref);
  if (!depositRef) {
    return adminJson({ ok: false, error: "Invalid payment reference" }, 400);
  }

  try {
    const investigation = await loadDepositDetail(depositRef);
    if (!investigation) {
      return adminJson({ ok: false, error: "Payment not found" }, 404);
    }
    return adminJson({ ok: true, ref: depositRef, investigation });
  } catch (error) {
    return adminError("deposit investigation", error);
  }
}
