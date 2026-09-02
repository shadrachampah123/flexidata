import { requireAccount } from "@/lib/api-auth";
import { getTrackableTx } from "@/lib/data";
import { buildTrackingInfo } from "@/lib/fulfillment";

export const dynamic = "force-dynamic";

/**
 * Live order tracking endpoint. The tracker UI polls this while an order is in
 * flight to refresh its stage, progress and delivery ETA. Scoped to the
 * signed-in wallet by {@link getTrackableTx}, so a user can only ever read the
 * status of their own orders.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ref: string }> },
) {
  const auth = await requireAccount();
  if (!auth.ok) return auth.response;

  const { ref } = await params;
  if (!ref) {
    return Response.json({ ok: false, error: "Missing reference" }, { status: 400 });
  }

  try {
    const tx = await getTrackableTx(auth.wallet.id, ref);
    if (!tx) {
      return Response.json({ ok: false, error: "Order not found" }, { status: 404 });
    }

    const tracking = buildTrackingInfo(tx);
    return Response.json(
      { ok: true, tracking },
      {
        headers: {
          // Never cache: the whole point is a fresh, live view.
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (error) {
    console.error("track lookup error", error);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
