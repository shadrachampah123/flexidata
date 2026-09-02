import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { CheckoutResult } from "@/components/checkout-result";

export const dynamic = "force-dynamic";

/**
 * Landing page after the customer returns from Paystack checkout. The page
 * itself proves nothing about payment — the client component polls
 * /api/checkout/verify, which confirms the charge with Paystack server-side
 * before anything is treated as paid or fulfilled.
 */
export default async function CheckoutCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string; reference?: string; trxref?: string }>;
}) {
  const { wallet } = await requireSession();
  const params = await searchParams;
  // Paystack appends ?reference=&trxref= to the callback URL; we also pass
  // our own ?ref=. Any of them identifies the order.
  const ref = (params.ref ?? params.reference ?? params.trxref ?? "").trim();
  if (!ref) redirect("/data");

  return (
    <div>
      <PageHeader
        title="Payment status"
        subtitle={`Order ${ref}`}
        backHref="/data"
        balance={wallet.balance}
      />
      <CheckoutResult orderRef={ref} />
    </div>
  );
}
