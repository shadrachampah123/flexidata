
/**
 * Transactional messages (password resets, receipts).
 *
 * In local development (or when no email webhook is configured) the message is
 * logged to the server console AND returned by the calling API so the UI can
 * surface a dev-mode link — this keeps the forgot-password flow fully testable
 * end to end without an email provider.
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

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );
}

export async function sendPasswordResetEmail(
  to: string,
  token: string,
): Promise<NotifyResult> {
  const link = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
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
