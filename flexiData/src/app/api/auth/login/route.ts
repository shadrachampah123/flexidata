import { randomBytes } from "node:crypto";
import { createSession } from "@/lib/auth";
import { verifyLogin } from "@/lib/accounts";

export const dynamic = "force-dynamic";

type Body = { identifier?: string; password?: string };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const identifier = (body.identifier ?? "").trim();
    const password = body.password ?? "";

    if (!identifier || !password) {
      return Response.json({ ok: false, error: "Enter your email or phone and password" }, { status: 400 });
    }

    const user = await verifyLogin(identifier, password);
    if (!user) {
      return Response.json(
        { ok: false, error: "Incorrect login details. Check and try again." },
        { status: 401 },
      );
    }

    // The credentials are valid — a failure past this point is the
    // deployment's, not the visitor's. Answer honestly (a bare 500 here reads
    // as "wrong details" and sends people to the password-reset flow, which
    // cannot fix an environment problem).
    try {
      await createSession(user.id);
    } catch (sessionError) {
      const ref = randomBytes(3).toString("hex").toUpperCase();
      console.error(`[flexidata] login: session creation failed for user ${user.id} ref=${ref}`, sessionError);
      return Response.json(
        { ok: false, error: "Sign-in is temporarily unavailable. Please try again shortly." },
        { status: 503 },
      );
    }
    return Response.json({ ok: true, name: user.name });
  } catch (error) {
    console.error("login error", error);
    return Response.json({ ok: false, error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
