import { requireAdmin } from "@/lib/admin/auth";
import { AdminPageHead } from "@/components/admin/page-head";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { parsePage, parsePageSize, q, type RawSearchParams } from "@/lib/admin/filters";
import { PayoutReconciliationExplorer } from "./explorer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payout Reconciliation · FlexiData" };

export default async function PayoutReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const page = parsePage(q(params, "page"));
  const pageSize = parsePageSize(q(params, "pageSize"));
  const type = q(params, "type");
  const resolved = q(params, "resolved");

  // Fetch exceptions
  const conditions = [];
  if (type) conditions.push(sql`exception_type = ${type}`);
  if (resolved !== "") conditions.push(sql`resolved = ${resolved === "true"}`);
  const whereClause = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
  const offset = (page - 1) * pageSize;

  let rows: any[] = [];
  let total = 0;
  try {
    const [rowsResult, countResult] = await Promise.all([
      db.execute(sql`SELECT * FROM payout_reconciliation_exceptions ${whereClause} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`),
      db.execute(sql`SELECT count(*)::int as count FROM payout_reconciliation_exceptions ${whereClause}`),
    ]);
    rows = rowsResult.rows as any[];
    total = (countResult.rows[0] as { count: number })?.count ?? 0;
  } catch {
    // Table might not exist yet
    rows = [];
    total = 0;
  }

  return (
    <div className="space-y-4">
      <AdminPageHead
        title="Payout Reconciliation"
        subtitle="Exceptions found during reconciliation between local withdrawal state and provider state. Read-only diagnosis — no automatic balance changes."
      />
      <PayoutReconciliationExplorer
        initialRows={rows}
        initialTotal={total}
        initialPage={page}
        pageSize={pageSize}
        initialFilters={{ type: type || "", resolved: resolved || "" }}
      />
    </div>
  );
}
