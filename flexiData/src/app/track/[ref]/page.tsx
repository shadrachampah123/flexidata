import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { requireSession } from "@/lib/session";
import { getTrackableTx } from "@/lib/data";
import { buildTrackingInfo } from "@/lib/fulfillment";
import { PageHeader } from "@/components/page-header";
import { OrderTracker } from "@/components/order-tracker";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function TrackOrderPage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  const { ref } = await params;
  const { wallet } = await requireSession();

  const tx = await getTrackableTx(wallet.id, ref);
  if (!tx) notFound();

  const tracking = buildTrackingInfo(tx);

  return (
    <div>
      <PageHeader
        title="Track order"
        subtitle={`Reference ${tracking.ref}`}
        backHref="/history"
        balance={wallet.balance}
      />

      <Card className="animate-fade-up p-5">
        <OrderTracker initial={tracking} />
      </Card>

      <div
        className="animate-fade-up mt-4 flex items-start gap-2.5 rounded-2xl border border-black/[0.06] bg-black/[0.02] px-4 py-3 text-[11px] text-zinc-500 dark:border-line dark:bg-white/[0.03] dark:text-zinc-400"
        style={{ animationDelay: "80ms" }}
      >
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-deep dark:text-brand" />
        <p>
          If a bundle isn&apos;t received within the estimated window it is
          automatically retried, and any failed order is refunded to your wallet
          in full. Questions? Reach us from{" "}
          <Link href="/more" className="font-bold text-brand-deep underline dark:text-brand">
            Help &amp; support
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
