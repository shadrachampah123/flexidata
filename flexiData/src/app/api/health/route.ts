import { sql } from "drizzle-orm";
import { db } from "@/db";
import { hasAuthSecret } from "@/lib/auth";
import { getPasswordResetEmailDeliveryStatus } from "@/lib/notifications";
import { paymentsProvider } from "@/lib/payments";
import { paystackMode } from "@/lib/paystack";
import { repairCheckoutOrdersSchema, ensureWithdrawalSchema } from "@/lib/seed";
import {
  describeAdminAuditCompatibility,
  describeAuthCompatibility,
  describeCheckoutCompatibility,
  describeSchemaCompatibility,
  describeSignupCompatibility,
  describeWithdrawalCompatibility,
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

  // Same additive self-heal for the withdrawal objects. `withdrawal_requests`
  // arrived without its migration SQL, so a database deployed from this
  // repository could be missing it while every other probe below still reads
  // "current" — which is what turned POST /api/wallet/withdraw into a bare 500.
  await ensureWithdrawalSchema();

  // A pre-gateway schema is survivable (the app degrades), but it must be
  // visible here so a stuck deployment is diagnosable at a glance.
  const schema = await describeSchemaCompatibility();
  const checkout = await describeCheckoutCompatibility();
  const signup = await describeSignupCompatibility();
  const auth = await describeAuthCompatibility();
  const withdrawal = await describeWithdrawalCompatibility();
  const adminAudit = await describeAdminAuditCompatibility();
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
    // Withdrawals have no runtime fallback: without `withdrawal_requests` the
    // route cannot record a request at all. Reported separately for the same
    // reason sign-up drift is — it is the one schema gap the app cannot work
    // around, so it must never be invisible.
    withdrawalSchema: {
      status: withdrawal.status,
      blocked: withdrawal.status === "missing",
      table: withdrawal.table,
      missing: withdrawal.missing,
      ...(withdrawal.hint ? { hint: withdrawal.hint } : {}),
    },
    // The admin withdrawal actions can fail on an object NO other probe
    // covers: the audit action CHECK predating `approve_withdrawal` /
    // `reject_withdrawal` rolls back every approve/reject (SQLSTATE 23514)
    // while the withdrawal schema above still reads "current".
    adminAuditSchema: {
      status: adminAudit.status,
      blocked: adminAudit.status === "legacy" || adminAudit.status === "missing",
      table: adminAudit.table,
      missing: adminAudit.missing,
      ...(adminAudit.hint ? { hint: adminAudit.hint } : {}),
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
    ...(withdrawal.status === "missing" || withdrawal.status === "drifted"
      ? {
          withdrawalWarning:
            "Withdrawals are blocked: the withdrawal schema is not in this database. " +
            "Run `npx drizzle-kit push` against it (drizzle/0005_lively_hiroim.sql).",
        }
      : {}),
    ...(adminAudit.status === "legacy" || adminAudit.status === "missing"
      ? {
          adminAuditWarning:
            "Admin approve/reject of withdrawals is blocked: the audit action constraint predates the " +
            "withdrawal actions and every admin withdrawal action rolls back (SQLSTATE 23514). Apply " +
            "drizzle/0007 with `npm run migrate:admin-audit-actions` (targeted, non-destructive) — " +
            "prefer it over `npx drizzle-kit push`, which diffs the whole schema and would also request " +
            "removal of any tables that exist in the database but not in src/db/schema.ts.",
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
