import { requireAdminApi } from "@/lib/admin/auth";
import { adminError, adminJson } from "@/lib/admin/api";
import { parseRef } from "@/lib/admin/filters";
import { loadOrderInvestigation } from "@/lib/admin/queries-investigation";

/**
 * `GET /api/admin/orders/[ref]` — one Paystack checkout order in full.
 *
 * Phase 2, Step 3 (S3.1). This is the drill-down the data-operations and
 * needs-support screens were missing: before it, a checkout reference linked to
 * the LEDGER view, which 404s for every order that never reached the provider
 * submit path — i.e. exactly the parked, in-flight and mismatch rows an
 * operator needs to investigate.
 *
 * Read-only. The whole payload is produced inside `withReadOnlyTx` (the
 * database itself refuses a write in that transaction) and classified by the
 * pure engine in `src/lib/admin/diagnosis.ts`. Nothing here can settle an
 * order, credit a wallet, refund, reverse, retry a delivery or write an audit
 * row: no write API is imported and no settlement module is reachable.
 *
 * The money columns are returned for DISPLAY. They are the values Paystack and
 * the provider last wrote; this endpoint has no way to change them.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;

  const { ref } = await params;
  const orderRef = parseRef(ref);
  if (!orderRef) {
    return adminJson({ ok: false, error: "Invalid order reference" }, 400);
  }

  try {
    const investigation = await loadOrderInvestigation(orderRef);
    if (!investigation) {
      return adminJson({ ok: false, error: "Order not found" }, 404);
    }
    return adminJson({ ok: true, ref: orderRef, investigation });
  } catch (error) {
    return adminError("order investigation", error);
  }
}
