import { randomBytes } from "node:crypto";
import { assertAuthSecretConfigured, createSession } from "@/lib/auth";
import { registerUser, verifyLogin } from "@/lib/accounts";

export const dynamic = "force-dynamic";

type Body = {
  name?: string;
  email?: string;
  phone?: string;
  password?: string;
  referralCode?: string;
};

export async function POST(req: Request) {
  try {
    // Preflight, before anything is written. A deployment that cannot sign
    // session cookies (missing/short AUTH_SECRET) used to commit the account
    // in registerUser and only then fail — the "(ref …)" 500 that left the
    // email "already used" but its owner signed out. Fail up front instead:
    // nothing is created, so the retry after the env is fixed just works.
    assertAuthSecretConfigured();

    const body = (await req.json()) as Body;
    const result = await registerUser({
      name: body.name ?? "",
      email: body.email ?? "",
      phone: body.phone ?? "",
      password: body.password ?? "",
      referralCode: body.referralCode?.trim() || null,
    });

    if (!result.ok) {
      // Self-heal accounts orphaned by the old failure mode: the account
      // exists, and a returning visitor who knows its password is exactly who
      // the login screen would let in — so treat the retry as a sign-in
      // instead of a permanent "email already used" dead end.
      if (result.reason === "email-exists") {
        const existing = await verifyLogin(body.email ?? "", body.password ?? "");
        if (existing) {
          try {
            await createSession(existing.id);
            return Response.json({ ok: true, recovered: true });
          } catch (sessionError) {
            const ref = randomBytes(3).toString("hex").toUpperCase();
            console.error(
              `[flexidata] register: existing account ${existing.id} could not be signed in ref=${ref}`,
              sessionError,
            );
            return Response.json({ ok: true, needsLogin: true });
          }
        }
      }
      return Response.json({ ok: false, error: result.error }, { status: 400 });
    }

    // The account is committed at this point. If the session still cannot be
    // created (e.g. a sessions table the migrations never reached), do NOT
    // report "registration failed" — that sends the visitor into the retry →
    // "email already used" loop. Their account is real: own it, log loudly,
    // and send them to sign in.
    try {
      await createSession(result.userId);
    } catch (sessionError) {
      const ref = randomBytes(3).toString("hex").toUpperCase();
      console.error(
        `[flexidata] register: account ${result.userId} created but session creation failed ref=${ref}`,
        sessionError,
      );
      return Response.json({ ok: true, needsLogin: true });
    }
    return Response.json({ ok: true });
  } catch (error) {
    // A bare 500 is how this bug stayed hidden for so long: the real cause was
    // in the server log, but there was nothing to tie a user's report to it.
    // The ref is shown to the visitor and logged beside the error, so one
    // search of the Vercel logs finds the exact failure.
    const ref = randomBytes(3).toString("hex").toUpperCase();
    console.error(`[flexidata] register failed ref=${ref}`, error);
    return Response.json(
      { ok: false, error: `Something went wrong. Please try again. (ref ${ref})` },
      { status: 500 },
    );
  }
}
