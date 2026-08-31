import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Body = { promos?: boolean; transactions?: boolean };

export async function PATCH(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: "Not signed in" }, { status: 401 });

    const body = (await req.json()) as Body;
    await db
      .update(users)
      .set({
        ...(typeof body.promos === "boolean" ? { notifyPromos: body.promos } : {}),
        ...(typeof body.transactions === "boolean" ? { notifyTx: body.transactions } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return Response.json({
      ok: true,
      notifyPromos: typeof body.promos === "boolean" ? body.promos : user.notifyPromos,
      notifyTx: typeof body.transactions === "boolean" ? body.transactions : user.notifyTx,
    });
  } catch (error) {
    console.error("notifications update error", error);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
