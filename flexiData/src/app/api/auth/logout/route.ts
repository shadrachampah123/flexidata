import { destroyCurrentSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  await destroyCurrentSession();
  return Response.json({ ok: true });
}
