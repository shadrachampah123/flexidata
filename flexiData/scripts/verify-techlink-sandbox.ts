/**
 * Opt-in, read-only Techlink sandbox catalogue smoke test.
 *
 * This script never imports or calls the purchase adapter. It skips unless the
 * operator explicitly sets TECHLINK_RUN_SANDBOX_TEST=true, a test key is
 * present, sandbox mode is selected, and a test phone is supplied. It checks
 * only key presence; it never prints the key.
 */
import { fetchTechlinkCatalogue } from "../src/lib/techlink";
import { normalizeGhanaMobileStrict } from "../src/lib/ghana-mobile";

const env = process.env;

function skip(reason: string): void {
  console.log(`SKIP Techlink sandbox catalogue smoke test: ${reason}`);
}

async function main(): Promise<void> {
  if (env.TECHLINK_RUN_SANDBOX_TEST?.trim().toLowerCase() !== "true") {
    skip("TECHLINK_RUN_SANDBOX_TEST is not true");
    return;
  }
  if (!env.TECHLINK_TEST_API_KEY?.trim()) {
    skip("TECHLINK_TEST_API_KEY is absent");
    return;
  }
  if (env.NODE_ENV === "production") {
    skip("production runtime is never eligible");
    return;
  }
  if (env.TECHLINK_MODE?.trim().toLowerCase() !== "sandbox") {
    skip("TECHLINK_MODE is not sandbox");
    return;
  }
  const phone = env.TECHLINK_TEST_PHONE?.trim() ?? "";
  if (!normalizeGhanaMobileStrict(phone).ok) {
    skip("TECHLINK_TEST_PHONE is absent or invalid");
    return;
  }
  const network = (env.TECHLINK_TEST_NETWORK?.trim().toUpperCase() || "MTN") as "MTN" | "TELECEL";
  if (network !== "MTN" && network !== "TELECEL") {
    skip("TECHLINK_TEST_NETWORK must be MTN or TELECEL");
    return;
  }

  try {
    const catalogue = await fetchTechlinkCatalogue(network, phone);
    console.log(`PASS Techlink sandbox catalogue read: ${catalogue.bundles.length} bundle(s) returned`);
  } catch (error) {
    // Do not print provider responses, URLs, headers, or configuration values.
    const name = error instanceof Error ? error.name : "Error";
    throw new Error(`Techlink sandbox catalogue read failed (${name})`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Techlink sandbox catalogue read failed");
  process.exitCode = 1;
});
