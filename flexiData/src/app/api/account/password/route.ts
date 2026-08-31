import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { destroyOtherSessions, getCurrentUser, setUserPassword, verifyPasswordAuth } from "@/lib/auth";
import { passwordStrength } from "@/lib/accounts";

export const dynamic = "force-dynamic";

type Body = { currentPassword?: string; newPassword?: string };

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: "Not signed in" }, { status: 401 });

    const body = (await req.json()) as Body;
    const currentPassword = body.currentPassword ?? "";
    const newPassword = body.newPassword ?? "";

    if (!currentPassword) {
      return Response.json({ ok: false, error: "Enter your current password" }, { status: 400 });
    }
    const strength = passwordStrength(newPassword);
    if (!strength.ok) {
      return Response.json({ ok: false, error: strength.error ?? "Weak password" }, { status: 400 });
    }

    const row = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (!row[0] || !verifyPasswordAuth(currentPassword, row[0].passwordHash)) {
      return Response.json({ ok: false, error: "Current password is incorrect" }, { status: 400 });
    }

    await setUserPassword(user.id, newPassword);
    // Keep the current device signed in, drop every other session.
    await destroyOtherSessions(user.id).catch(() => {});

    return Response.json({ ok: true, message: "Password changed" });
  } catch (error) {
    console.error("password change error", error);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
