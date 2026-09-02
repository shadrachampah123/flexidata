
/**
 * Transactional messages (password resets, receipts).
 *
 * In local development (or when no email webhook is configured) the message is
 * logged to the server console AND returned by the calling API so the UI can
 * surface a dev-mode link — this keeps the forgot-password flow fully testable
 * end to end without an email provider. Neither of those happens in
 * production: a live reset link must never be logged or returned to the
 * caller, and when no transport is configured the send is reported as failed
 * instead of being silently swallowed.
 *
 * In production set NOTIFY_WEBHOOK_URL to a transactional-email relay
 * (Resend, SendGrid, Mailgun, Brevo...) that accepts a simple JSON POST:
 *   { to, subject, text, html }
 */

export type NotifyResult = {
  delivered: boolean;
  devMode: boolean;
  previewUrl?: string;
};

/**
 * The host the request actually arrived on — the only base URL guaranteed to
 * reach this deployment, whatever the env configuration. Reads the forwarding
 * headers first (Vercel / proxies), then the Host header, then the URL itself.
 */
export function requestOrigin(req: Request): string | null {
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.headers.get("host")?.trim() || null;
  if (host) {
    let proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || null;
    if (!proto) {
      try {
        proto = new URL(req.url).protocol.replace(/:$/, "") || null;
      } catch {
        proto = null;
      }
    }
    if (!proto) proto = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host) ? "http" : "https";
    return `${proto}://${host}`;
  }
  try {
    const origin = new URL(req.url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Base URL for links the app hands to people (reset emails, payment
 * callbacks), in the order each source can actually be relied on:
 *
 *   1. APP_BASE_URL / NEXT_PUBLIC_APP_URL — explicit operator config, wins.
 *   2. The origin of the request being handled — reaches this deployment by
 *      definition, so links stay correct even when APP_BASE_URL was never set
 *      or still points at localhost (the "broken reset link" incident).
 *   3. VERCEL_URL — set by the platform on every deployment.
 *   4. http://localhost:3000 — only outside production.
 *
 * Returns null when none apply (production with no origin determinable):
 * callers must fail honestly rather than fabricate a localhost link nobody
 * can open.
 */
export function resolveAppBaseUrl(origin?: string | null): string | null {
  const configured = (process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (configured) return configured;

  const fromRequest = origin?.trim().replace(/\/+$/, "");
  if (fromRequest) return fromRequest;

  const vercel = process.env.VERCEL_URL?.trim().replace(/\/+$/, "");
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "")}`;

  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";
  return null;
}

export async function sendPasswordResetEmail(
  to: string,
  token: string,
  origin?: string | null,
): Promise<NotifyResult> {
  const base = resolveAppBaseUrl(origin);
  if (!base) {
    console.error(
      "[flexidata] cannot build a password reset link: APP_BASE_URL is unset and no request " +
        "origin or VERCEL_URL is available. Set APP_BASE_URL to the public https:// URL of this deployment.",
    );
    return { delivered: false, devMode: false };
  }
  const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
  const subject = "Reset your FlexiData password";
  const text = [
    "Hi,",
    "",
    "We received a request to reset your FlexiData password.",
    `Open this link to choose a new one (valid for 1 hour):`,
    "",
    link,
    "",
    "If you didn't request this, you can safely ignore this email — your password stays unchanged.",
    "",
    "— The FlexiData team",
  ].join("\n");

  const webhook = process.env.NOTIFY_WEBHOOK_URL?.trim();
  if (!webhook) {
    if (process.env.NODE_ENV === "production") {
      // No transport: pretending the email was sent leaves the visitor waiting
      // on a link that does not exist, and logging the link hands account
      // takeover to anyone with log access. Report the send as failed — the
      // route answers honestly, and this line is the operator's fix guide.
      console.error(
        "[flexidata] NOTIFY_WEBHOOK_URL is not set, so password reset emails cannot be sent in " +
          "production. Point it at your transactional-email relay (Resend/SendGrid/Mailgun/Brevo).",
      );
      return { delivered: false, devMode: true };
    }
    console.info(`[flexidata][dev] Password reset for ${to}: ${link}`);
    return { delivered: true, devMode: true, previewUrl: link };
  }

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to,
        subject,
        text,
        html: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br/>"),
      }),
    });
    if (!res.ok) {
      console.error("[flexidata] email webhook failed", res.status);
      return { delivered: false, devMode: false };
    }
    return { delivered: true, devMode: false };
  } catch (error) {
    console.error("[flexidata] email webhook error", error);
    return { delivered: false, devMode: false };
  }
}
