import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireAccount } from "@/lib/api-auth";
import { CheckoutInputError, createCheckoutOrder } from "@/lib/checkout";
import { isPaystackConfigured, PaystackConfigError, PaystackRequestError } from "@/lib/paystack";
import { isMissingRelationError } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

type Body = {
  network?: string;
  category?: string;
  planLabel?: string;
  recipient?: string;
};

/**
 * Start a Paystack checkout for a data bundle.
 *
 * The client only names the plan (network + category + label) and the
 * recipient. Everything money-related — price, currency, reference — is
 * resolved server-side; the response contains only the redirect URL and
 * public order facts. The Paystack secret key never appears here.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAccount();
    if (!auth.ok) return auth.response;

    if (!isPaystackConfigured()) {
      return Response.json(
        { ok: false, error: "Card / mobile money checkout is not available right now.", code: "paystack_unconfigured" },
        { status: 503 },
      );
    }

    const body = (await req.json().catch(() => ({}))) as Body;

    const accountRows = await db
      .select({ email: users.email, phone: users.phone })
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1);
    const account = accountRows[0];
    const email = account?.email ?? `${auth.wallet.number}@flexidata.app`;

    const order = await createCheckoutOrder({
      userId: auth.userId,
      walletId: auth.wallet.id,
      customerEmail: email,
      customerPhone: account?.phone ?? auth.wallet.number,
      network: body.network ?? "",
      category: body.category ?? "",
      planLabel: body.planLabel ?? "",
      recipient: body.recipient ?? "",
      requestOrigin: new URL(req.url).origin,
    });

    return Response.json({
      ok: true,
      ref: order.ref,
      authorizationUrl: order.authorizationUrl,
      amount: order.amount,
      currency: "GHS",
      planLabel: order.planLabel,
    });
  } catch (error) {
    if (error instanceof CheckoutInputError) {
      return Response.json({ ok: false, error: error.message }, { status: 400 });
    }
    if (error instanceof PaystackConfigError) {
      // Config problems (missing key / live-mode lock) are logged server-side
      // only; the client gets a generic, key-free message.
      console.error("checkout config error:", error.message);
      return Response.json(
        { ok: false, error: "Checkout is not available right now. Please try again later.", code: "paystack_unconfigured" },
        { status: 503 },
      );
    }
    if (error instanceof PaystackRequestError) {
      console.error("checkout init error:", error.message);
      return Response.json(
        { ok: false, error: "Could not start the payment. Please try again.", code: "paystack_init_failed" },
        { status: 502 },
      );
    }
    if (isMissingRelationError(error)) {
      console.error("checkout schema error: checkout_orders table missing — run `npx drizzle-kit push`.");
      return Response.json(
        { ok: false, error: "Checkout is being upgraded. Please try again shortly.", code: "schema_out_of_date" },
        { status: 503 },
      );
    }
    console.error("checkout error", error);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
