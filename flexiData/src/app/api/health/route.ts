import { sql } from "drizzle-orm";
import { db } from "@/db";
import { hasAuthSecret } from "@/lib/auth";
import { getPasswordResetEmailDeliveryStatus } from "@/lib/notifications";
import { paymentsProvider } from "@/lib/payments";
import { paystackMode } from "@/lib/paystack";
import { repairCheckoutOrdersSchema } from "@/lib/seed";
import {
  describeAuthCompatibility,
  describeCheckoutCompatibility,
  describeSchemaCompatibility,
  describeSignupCompatibility,
  resetSchemaCapabilitiesCache,
} from "@/lib/schema-compat";

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

  // Additive self-heal: create checkout_orders if a production database never
  // received the Paystack checkout migration. Never drops or rewrites data.
  try {
    await repairCheckoutOrdersSchema();
    resetSchemaCapabilitiesCache();
  } catch (error) {
    console.warn("[flexidata] checkout schema repair failed", error);
  }

  // A pre-gateway schema is survivable (the app degrades), but it must be
  // visible here so a stuck deployment is diagnosable at a glance.
  const schema = await describeSchemaCompatibility();
  const checkout = await describeCheckoutCompatibility();
  const signup = await describeSignupCompatibility();
  const auth = await describeAuthCompatibility();
  const degraded = schema.status === "legacy";
  // Sign-up drift is reported separately because it is the one thing the
  // runtime cannot silently work around: missing *required* columns there block
  // account creation outright. Same for the session/reset tables the auth
  // lifecycle writes to.
  const signupBlocked = signup.requiredMissing.length > 0;
  const authBlocked = auth.requiredMissing.length > 0;
  const secretConfigured = hasAuthSecret();
  const resetEmail = getPasswordResetEmailDeliveryStatus();
  // Wallet funding configuration. Safe to expose: it names the gateway and its
  // test/live mode only — `paystackMode()` never returns key material. The
  // production fail-closed lock can refuse mock/unconfigured funding, so handle
  // that as an explicit operational state rather than crashing the health API.
  let fundingProvider: string;
  let fundingLocked = false;
  try {
    fundingProvider = paymentsProvider();
  } catch {
    fundingProvider = "unavailable";
    fundingLocked = true;
  }
  const fundingMode = paystackMode();

  return Response.json({
    ok: true,
    database: "connected",
    gatewaySchema: schema.status,
    checkoutSchema: {
      status: checkout.status,
      missing: checkout.missing,
      ...(checkout.hint ? { hint: checkout.hint } : {}),
    },
    signupSchema: {
      status: signup.status,
      blocked: signupBlocked,
      missing: signup.missing,
      requiredMissing: signup.requiredMissing,
      ...(signup.hint ? { hint: signup.hint } : {}),
    },
    auth: {
      // The two operational causes of the orphaned-account incident: a missing
      // AUTH_SECRET (sign-up committed, session never signed) and a sessions
      // table the migrations never reached. Both are visible here at a glance.
      secretConfigured,
      schema: {
        status: auth.status,
        blocked: authBlocked,
        missing: auth.missing,
        requiredMissing: auth.requiredMissing,
        ...(auth.hint ? { hint: auth.hint } : {}),
      },
      // Safe to expose: it names only the active transport and never leaks
      // a key, sender address, relay URL, or reset token.
      passwordResetEmail: resetEmail,
    },
    payments: {
      provider: fundingProvider,
      paystack: fundingMode,
      ...(fundingProvider === "paystack"
        ? {
            hint:
              fundingMode === "test"
                ? "Wallet deposits go through Paystack TEST mode — no real money moves."
                : "Wallet deposits go through Paystack LIVE mode.",
          }
        : fundingLocked
          ? {
              warning:
                "Wallet funding is LOCKED OUT in this production runtime: mock deposits are never allowed and no Paystack key is configured. " +
                "Set PAYSTACK_SECRET_KEY (sk_test_…) and remove PAYMENTS_PROVIDER=mock.",
            }
          : {
              warning:
                "Wallet deposits are SIMULATED (mock provider): the wallet is credited without a real payment. " +
                "Set PAYSTACK_SECRET_KEY (sk_test_…) and remove PAYMENTS_PROVIDER=mock to charge through Paystack.",
            }),
    },
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
    ...(signupBlocked
      ? {
          signupWarning:
            "Sign-up is blocked: the database is missing required columns. Run `npx drizzle-kit push` against it.",
        }
      : {}),
    ...(authBlocked
      ? {
          authWarning:
            "Sessions/password resets are blocked: the database is missing required columns. Run `npx drizzle-kit push` against it.",
        }
      : {}),
    ...(!secretConfigured
      ? {
          authSecretWarning:
            "AUTH_SECRET is missing or too short — sign-up and sign-in cannot issue sessions until it is set.",
        }
      : {}),
  });
}
