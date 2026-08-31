import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { scheduledTopups } from "@/db/schema";
import { getWalletRow } from "@/lib/data";
import { isValidPhone } from "@/lib/format";

export const dynamic = "force-dynamic";

type CreateBody = {
  network?: string;
  planLabel?: string;
  price?: number;
  recipient?: string;
  dayOfMonth?: number;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateBody;
    const { network, planLabel } = body;
    const price = Number(body.price);
    const day = Number(body.dayOfMonth);

    if (!network || (network !== "MTN" && network !== "TELECEL")) {
      return Response.json({ ok: false, error: "Choose a network" }, { status: 400 });
    }
    if (!planLabel || !Number.isFinite(price) || price <= 0) {
      return Response.json({ ok: false, error: "Choose a bundle" }, { status: 400 });
    }
    if (!body.recipient || !isValidPhone(body.recipient)) {
      return Response.json({ ok: false, error: "Enter a valid recipient number" }, { status: 400 });
    }
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      return Response.json({ ok: false, error: "Pick a day between 1 and 28" }, { status: 400 });
    }

    const wallet = await getWalletRow();
    const inserted = await db
      .insert(scheduledTopups)
      .values({
        walletId: wallet.id,
        network,
        planLabel,
        price: price.toFixed(2),
        recipient: body.recipient,
        dayOfMonth: day,
      })
      .returning();

    const s = inserted[0];
    return Response.json({
      ok: true,
      schedule: {
        id: s.id,
        network: s.network,
        planLabel: s.planLabel,
        price: Number(s.price),
        recipient: s.recipient,
        dayOfMonth: s.dayOfMonth,
        active: s.active,
      },
    });
  } catch (e) {
    console.error("schedule create error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}

type MutateBody = { id?: number; active?: boolean };

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as MutateBody;
    const id = Number(body.id);
    if (!Number.isInteger(id) || typeof body.active !== "boolean") {
      return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
    }
    const wallet = await getWalletRow();
    await db
      .update(scheduledTopups)
      .set({ active: body.active })
      .where(and(eq(scheduledTopups.id, id), eq(scheduledTopups.walletId, wallet.id)));
    return Response.json({ ok: true });
  } catch (e) {
    console.error("schedule patch error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as MutateBody;
    const id = Number(body.id);
    if (!Number.isInteger(id)) {
      return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
    }
    const wallet = await getWalletRow();
    await db
      .delete(scheduledTopups)
      .where(and(eq(scheduledTopups.id, id), eq(scheduledTopups.walletId, wallet.id)));
    return Response.json({ ok: true });
  } catch (e) {
    console.error("schedule delete error", e);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
