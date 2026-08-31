import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { isLikelyEmail, normalizeEmail, normalizePhone, syncWalletIdentity } from "@/lib/accounts";
import { isValidPhone } from "@/lib/format";

export const dynamic = "force-dynamic";

type Body = { name?: string; email?: string; phone?: string };

export async function PATCH(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: "Not signed in" }, { status: 401 });

    const body = (await req.json()) as Body;
    const name = (body.name ?? "").trim().replace(/\s+/g, " ");
    const email = normalizeEmail(body.email ?? "");
    const phone = normalizePhone(body.phone ?? "");

    if (name.length < 2) {
      return Response.json({ ok: false, error: "Enter your full name" }, { status: 400 });
    }
    if (!isLikelyEmail(email)) {
      return Response.json({ ok: false, error: "Enter a valid email address" }, { status: 400 });
    }
    if (!phone || !isValidPhone(phone)) {
      return Response.json({ ok: false, error: "Enter a valid phone number" }, { status: 400 });
    }

    // Uniqueness against other accounts.
    if (email !== user.email) {
      const clash = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (clash[0] && clash[0].id !== user.id) {
        return Response.json({ ok: false, error: "That email is used by another account" }, { status: 400 });
      }
    }
    if (phone !== user.phone) {
      const clash = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.phone, phone))
        .limit(1);
      if (clash[0] && clash[0].id !== user.id) {
        return Response.json({ ok: false, error: "That phone number is used by another account" }, { status: 400 });
      }
    }

    await db
      .update(users)
      .set({ name, email, phone, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    await syncWalletIdentity(user.id, name, phone);

    return Response.json({ ok: true, user: { name, email, phone } });
  } catch (error) {
    console.error("profile update error", error);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
