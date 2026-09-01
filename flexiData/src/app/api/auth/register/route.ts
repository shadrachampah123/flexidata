import { randomBytes } from "node:crypto";
import { createSession } from "@/lib/auth";
import { registerUser } from "@/lib/accounts";

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
    const body = (await req.json()) as Body;
    const result = await registerUser({
      name: body.name ?? "",
      email: body.email ?? "",
      phone: body.phone ?? "",
      password: body.password ?? "",
      referralCode: body.referralCode?.trim() || null,
    });

    if (!result.ok) {
      return Response.json({ ok: false, error: result.error }, { status: 400 });
    }

    await createSession(result.userId);
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
