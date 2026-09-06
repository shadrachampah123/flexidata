import { requireAdminApi } from "@/lib/admin/auth";
import { adminError, adminJson } from "@/lib/admin/api";
import { parseRef } from "@/lib/admin/filters";
import { loadDepositDetail } from "@/lib/admin/queries-investigation";
import { probePaystackStatus } from "@/lib/admin/paystack-status";
import type { ProbeSubject } from "@/lib/admin/diagnosis";

/**
 * `GET /api/admin/payments/[ref]/paystack-status` — ask Paystack what it holds
 * for one wallet deposit, and compare it with what we stored. Read-only. (S3.6)
 *
 * The deposit version of the order probe, for the two questions support actually
 * gets: "the customer says they topped up but the wallet never moved" and "this
 * deposit has been pending for a day". `reconcileDeposit()` is the only other
 * code that can answer them, and it CREDITS A WALLET — so it is not imported
 * here, and this endpoint cannot settle a deposit even by accident. If Paystack
 * confirms a matching charge that we never settled, the finding says so and
 * points at the customer's own verify path, which remains the only route into
 * `settleAtomic()`.
 *
 * `GET`, `force-dynamic`, `no-store`: it writes nothing, so it adds no browser
 * write surface.
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

    const subject: ProbeSubject = {
      kind: "deposit",
      ref: depositRef,
      storedStatus: investigation.deposit.status,
      storedAmountSubunits: investigation.deposit.amountSubunits,
      storedCurrency: investigation.deposit.currency,
      storedTransactionId: investigation.deposit.paystackTransactionId,
      credited: investigation.deposit.successfulCredits > 0,
    };

    const result = await probePaystackStatus({
      adminUserId: gate.context.admin.userId,
      subject,
    });

    if (!result.ok) {
      const status =
        result.error === "throttled"
          ? 429
          : result.error === "unavailable"
            ? 503
            : result.error === "timeout"
              ? 504
              : 502;
      return adminJson(result, status);
    }
    return adminJson(result);
  } catch (error) {
    return adminError("paystack deposit status probe", error);
  }
}
