import { deleteSessionById, destroyOtherSessions, getCurrentUser, listSessions } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: "Not signed in" }, { status: 401 });

  const sessions = await listSessions(user.id);
  return Response.json({
    ok: true,
    sessions: sessions.map((s) => ({
      id: s.id,
      device: s.userAgent,
      ip: s.ip,
      lastSeen: s.lastSeenAt.toISOString(),
      created: s.createdAt.toISOString(),
      current: s.current,
    })),
  });
}

type Body = { action?: "logout_others" | "logout_session"; sessionId?: number };

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ ok: false, error: "Not signed in" }, { status: 401 });

    const body = (await req.json()) as Body;
    if (body.action === "logout_others") {
      await destroyOtherSessions(user.id);
      return Response.json({ ok: true });
    }
    if (body.action === "logout_session" && typeof body.sessionId === "number") {
      await deleteSessionById(user.id, body.sessionId);
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("sessions error", error);
    return Response.json({ ok: false, error: "Something went wrong" }, { status: 500 });
  }
}
