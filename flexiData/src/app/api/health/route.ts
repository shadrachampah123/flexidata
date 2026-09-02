import { sql } from "drizzle-orm";
import { db } from "@/db";
import { hasAuthSecret } from "@/lib/auth";
import {
  describeAuthCompatibility,
  describeSchemaCompatibility,
  describeSignupCompatibility,
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

  // A pre-gateway schema is survivable (the app degrades), but it must be
  // visible here so a stuck deployment is diagnosable at a glance.
  const schema = await describeSchemaCompatibility();
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

  return Response.json({
    ok: true,
    database: "connected",
    gatewaySchema: schema.status,
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
