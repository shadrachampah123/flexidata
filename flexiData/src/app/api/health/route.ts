import { sql } from "drizzle-orm";
import { db } from "@/db";
import { describeSchemaCompatibility } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
  } catch (e) {
    return Response.json(
      {
        ok: false,
        database: "unreachable",
        error: e instanceof Error ? e.message : String(e),
        hint: "Check that DATABASE_URL is set in Vercel and that Neon allows connections from Vercel's servers.",
      },
      { status: 500 },
    );
  }

  // A pre-gateway schema is survivable (the app degrades), but it must be
  // visible here so a stuck deployment is diagnosable at a glance.
  const schema = await describeSchemaCompatibility();
  const degraded = schema.status === "legacy";

  return Response.json({
    ok: true,
    database: "connected",
    gatewaySchema: schema.status,
    dataGateway: {
      schema: schema.status,
      providerFloatTable: schema.providerFloatTable,
      missing: schema.missing,
      fallbacks: schema.fallbacks,
      ...(degraded ? { hint: schema.hint } : {}),
      ...(schema.status === "unknown"
        ? { note: "Could not read the catalog; gateway columns are assumed present." }
        : {}),
    },
    ...(degraded
      ? {
          warning:
            "The data gateway schema is out of date; provider fulfillment tracking is running with compatibility fallbacks.",
        }
      : {}),
  });
}
