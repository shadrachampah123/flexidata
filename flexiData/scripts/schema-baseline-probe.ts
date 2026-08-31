/**
 * Baseline probe for the data-gateway schema drift failure.
 *
 * It only touches app modules that exist before and after the fix, so the same
 * script can be run against both trees to show what the compatibility
 * fallbacks change. MIGRATED=true simulates a database where the gateway schema
 * has been pushed; MIGRATED=false (default) simulates one where it has not.
 *
 * Run with: npx tsx scripts/schema-baseline-probe.ts
 */
import { installSim } from "./schema-sim";

const migrated = process.env.MIGRATED === "true";
const { pool: getPool } = installSim({ migrated });

function jsonRequest(url: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function attempt(label: string, run: () => Promise<unknown>) {
  try {
    const detail = await run();
    console.log(`  OK    ${label}${detail === undefined ? "" : `  -> ${JSON.stringify(detail).slice(0, 120)}`}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  BROKEN ${label}  -> ${message.split("\n")[0].slice(0, 140)}`);
    return false;
  }
}

async function main() {
  console.log(
    `\nbaseline probe — gateway schema ${migrated ? "migrated" : "MISSING (pre-gateway database)"}`,
  );

  const { ensureSeeded } = require("@/lib/seed");
  const { getAllTransactions } = require("@/lib/data");
  const purchaseRoute = require("@/app/api/purchase/route");
  const callbackRoute = require("@/app/api/purchase/callback/route");
  const fundRoute = require("@/app/api/wallet/fund/route");
  const convertRoute = require("@/app/api/convert/route");

  const outcomes: boolean[] = [];
  let purchaseRef: string | undefined;

  outcomes.push(await attempt("app boot / seed (every page calls ensureSeeded)", () => ensureSeeded()));
  outcomes.push(await attempt("history list (mobile home + /history)", () => getAllTransactions()));

  outcomes.push(
    await attempt("buy data (POST /api/purchase)", async () => {
      const response = await purchaseRoute.POST(
        jsonRequest("/api/purchase", {
          kind: "data",
          network: "MTN",
          category: "up2u",
          planLabel: "1GB",
          recipient: "0244123456",
        }),
      );
      const body = await response.json();
      if (!body.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
      purchaseRef = body.ref;
      return { status: response.status, ok: body.ok, ref: body.ref, provider: body.provider };
    }),
  );

  outcomes.push(
    await attempt("fund wallet (POST /api/wallet/fund)", async () => {
      const response = await fundRoute.POST(jsonRequest("/api/wallet/fund", { method: "momo_mtn", amount: 50 }));
      const body = await response.json();
      if (!body.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
      return { status: response.status, ok: body.ok };
    }),
  );

  outcomes.push(
    await attempt("convert airtime (POST /api/convert)", async () => {
      const response = await convertRoute.POST(
        jsonRequest("/api/convert", { network: "MTN", phone: "0244123456", amount: 20 }),
      );
      const body = await response.json();
      if (!body.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
      return { status: response.status, ok: body.ok };
    }),
  );

  outcomes.push(
    await attempt("provider callback (POST /api/purchase/callback)", async () => {
      const response = await callbackRoute.POST(
        jsonRequest("/api/purchase/callback", {
          clientReference: purchaseRef ?? "FD-UNKNOWN",
          status: "successful",
          message: "Delivered by operator",
        }),
      );
      const body = await response.json();
      if (!body.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
      return { status: response.status, ok: body.ok };
    }),
  );

  const broken = outcomes.filter((ok) => !ok).length;
  console.log(`  ${outcomes.length - broken}/${outcomes.length} flows healthy`);
  process.exitCode = broken > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("probe crashed:", error);
  process.exitCode = 2;
});
