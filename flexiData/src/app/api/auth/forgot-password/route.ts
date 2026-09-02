import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createPasswordReset } from "@/lib/auth";
import { isLikelyEmail, normalizeEmail } from "@/lib/accounts";
import { requestOrigin, sendPasswordResetEmail } from "@/lib/notifications";

export const dynamic = "force-dynamic";

type Body = { email?: string };

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const email = (body.email ?? "").trim();

    if (!isLikelyEmail(email)) {
      return Response.json({ ok: false, error: "Enter the email you registered with" }, { status: 400 });
    }

    const rows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .limit(1);

    // The reset link is built from the origin this request arrived on, so it
    // reaches the deployment even when APP_BASE_URL was never configured (a
    // localhost link in an email is exactly the "broken reset link" reports).
    const origin = requestOrigin(req);

    let devPreviewUrl: string | undefined;
    if (rows[0]) {
      const reset = await createPasswordReset(rows[0].email);
      if (reset) {
        const result = await sendPasswordResetEmail(rows[0].email, reset.token, origin);
        // In production a live reset link must never appear in an API
        // response — anyone who knows an email address could take the account.
        if (result.previewUrl && process.env.NODE_ENV !== "production") {
          devPreviewUrl = result.previewUrl;
        }
        if (!result.delivered) {
          return Response.json(
            { ok: false, error: "Could not send the reset email right now. Try again shortly." },
            { status: 502 },
          );
        }
      }
    }

    // Always answer the same way (no account enumeration), but expose the link
    // in development/mock-notify mode so the flow is testable without email.
    return Response.json({
      ok: true,
      message: "If that email is registered, a password reset link is on its way.",
      ...(devPreviewUrl ? { devPreviewUrl } : {}),
    });
  } catch (error) {
    console.error("forgot-password error", error);
    return Response.json({ ok: false, error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
