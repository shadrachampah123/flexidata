import { consumePasswordReset, destroyOtherSessions, setUserPassword } from "@/lib/auth";
import { passwordStrength } from "@/lib/accounts";

export const dynamic = "force-dynamic";

type Body = { token?: string; password?: string };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const token = (body.token ?? "").trim();
    const password = body.password ?? "";

    if (!token) {
      return Response.json({ ok: false, error: "Missing reset token" }, { status: 400 });
    }
    const strength = passwordStrength(password);
    if (!strength.ok) {
      return Response.json({ ok: false, error: strength.error ?? "Weak password" }, { status: 400 });
    }

    const reset = await consumePasswordReset(token);
    if (!reset) {
      return Response.json(
        { ok: false, error: "This reset link is invalid or has expired. Request a new one." },
        { status: 400 },
      );
    }

    await setUserPassword(reset.userId, password);
    // Security: changing the password signs out every other device.
    await destroyOtherSessions(reset.userId).catch(() => {});

    return Response.json({ ok: true, message: "Password updated. You can sign in now." });
  } catch (error) {
    console.error("reset-password error", error);
    return Response.json({ ok: false, error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
