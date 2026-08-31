import { settleDeposit } from "@/app/api/wallet/fund/route";
import { verifyPaystackSignature, paymentsProvider } from "@/lib/payments";
import { db } from "@/db";
import { depositRequests } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Paystack server-to-server webhook. This is what actually credits the wallet
 * in production — the browser callback is only for UX. The signature is
 * verified against the raw request body (HMAC SHA-512, per Paystack docs).
 */
export async function POST(req: Request) {
  try {
    if (paymentsProvider() !== "paystack") {
      return Response.json({ ok: true, ignored: true });
    }

    const raw = await req.text();
    const signature = req.headers.get("x-paystack-signature");
    if (!(await verifyPaystackSignature(raw, signature))) {
      return Response.json({ ok: false }, { status: 401 });
    }

    const event = JSON.parse(raw) as { event?: string; data?: { reference?: string; status?: string } };
    if (event.event !== "charge.success" || !event.data?.reference) {
      return Response.json({ ok: true, ignored: event.event });
    }

    const ref = event.data.reference;
    const rows = await db
      .select({ ref: depositRequests.ref })
      .from(depositRequests)
      .where(eq(depositRequests.ref, ref))
      .limit(1);
    if (!rows[0]) return Response.json({ ok: true, ignored: "unknown_ref" });

    await settleDeposit(ref);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("webhook error", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
