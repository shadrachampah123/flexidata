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
    console.error("register error", error);
    return Response.json({ ok: false, error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
