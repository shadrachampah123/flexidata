/**
 * Transactional messages (password resets, receipts).
 *
 * Password-reset emails have a first-party Resend transport: set
 * RESEND_API_KEY and RESEND_FROM_EMAIL and the app sends straight to Resend's
 * API. A generic NOTIFY_WEBHOOK_URL is retained for teams that use another
 * provider behind their own relay.
 *
 * In local development (or when no email transport is configured) the message
 * is logged to the server console AND returned by the calling API so the UI can
 * surface a dev-mode link — this keeps the forgot-password flow fully testable
 * end to end without an email provider. Neither of those happens in
 * production: a live reset link must never be logged or returned to the
 * caller, and when no transport is configured the send is reported as failed
 * instead of being silently swallowed.
 */

export type NotifyResult = {
  delivered: boolean;
  devMode: boolean;
  previewUrl?: string;
};

export type PasswordResetEmailTransport =
  | "resend"
  | "webhook"
  | "development"
  | "unconfigured"
  | "misconfigured";

/** A safe, secret-free description for health checks and operator diagnostics. */
export type PasswordResetEmailDeliveryStatus = {
  provider: PasswordResetEmailTransport;
  configured: boolean;
  hint?: string;
};

function configured(value: string | undefined): string {
  return value?.trim() ?? "";
}

/**
 * Return the transport that will handle password-reset mail. Resend is used
 * directly when it is fully configured; a generic webhook remains available
 * for SendGrid, Mailgun, Brevo, or an in-house relay.
 */
export function getPasswordResetEmailDeliveryStatus(): PasswordResetEmailDeliveryStatus {
  const resendKey = configured(process.env.RESEND_API_KEY);
  const resendFrom = configured(process.env.RESEND_FROM_EMAIL);
  if (resendKey && resendFrom) return { provider: "resend", configured: true };

  if (configured(process.env.NOTIFY_WEBHOOK_URL)) return { provider: "webhook", configured: true };

  if (resendKey || resendFrom) {
    return {
      provider: "misconfigured",
      configured: false,
      hint: "Set both RESEND_API_KEY and RESEND_FROM_EMAIL to deliver password reset emails.",
    };
  }

  if (process.env.NODE_ENV !== "production") {
    return {
      provider: "development",
      configured: false,
      hint: "No real email is sent in development; the reset link is shown in the app and server log.",
    };
  }

  return {
    provider: "unconfigured",
    configured: false,
    hint: "Configure RESEND_API_KEY and RESEND_FROM_EMAIL, or NOTIFY_WEBHOOK_URL, to send password reset emails.",
  };
}

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
 *   1. APP_BASE_URL / NEXT_PUBLIC_APP_URL — explicit operator config, wins
 *      when it is a valid public URL. A loopback URL is ignored in production.
 *   2. The origin of the request being handled — reaches this deployment by
 *      definition, so links stay correct even when APP_BASE_URL was never set
 *      or was accidentally left pointing at localhost.
 *   3. VERCEL_URL — set by the platform on every deployment.
 *   4. http://localhost:3000 — only outside production.
 *
 * Returns null when none apply (production with no origin determinable):
 * callers must fail honestly rather than fabricate a localhost link nobody
 * can open.
 */
function normalizeHttpBaseUrl(value: string | null | undefined): string | null {
  const base = value?.trim().replace(/\/+$/, "") ?? "";
  if (!base) return null;
  try {
    const parsed = new URL(base);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? base : null;
  } catch {
    return null;
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "[::1]" || host.startsWith("127.");
  } catch {
    return false;
  }
}

export function resolveAppBaseUrl(origin?: string | null): string | null {
  // Treat APP_BASE_URL and NEXT_PUBLIC_APP_URL as separate candidates. That
  // means a stale/loopback APP_BASE_URL cannot mask a valid public fallback.
  const configuredUrl = [process.env.APP_BASE_URL, process.env.NEXT_PUBLIC_APP_URL]
    .map(normalizeHttpBaseUrl)
    .find((candidate) => candidate && (process.env.NODE_ENV !== "production" || !isLoopbackUrl(candidate)));
  // The sample env file uses localhost for developer convenience. If that
  // value is copied into a production deployment, sending it in email would
  // create a link that only works on the server itself. Prefer the real host.
  if (configuredUrl) return configuredUrl;

  const fromRequest = normalizeHttpBaseUrl(origin);
  if (fromRequest && (process.env.NODE_ENV !== "production" || !isLoopbackUrl(fromRequest))) {
    return fromRequest;
  }

  const vercelHost = process.env.VERCEL_URL?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const vercel = vercelHost ? normalizeHttpBaseUrl(`https://${vercelHost}`) : null;
  if (vercel) return vercel;

  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";
  return null;
}

type PasswordResetMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

async function sendWithResend(message: PasswordResetMessage): Promise<boolean> {
  const apiKey = configured(process.env.RESEND_API_KEY);
  const from = configured(process.env.RESEND_FROM_EMAIL);
  const replyTo = configured(process.env.RESEND_REPLY_TO);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!res.ok) {
      console.error("[flexidata] Resend password-reset email failed", res.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[flexidata] Resend password-reset email error", error);
    return false;
  }
}

async function sendWithWebhook(message: PasswordResetMessage): Promise<boolean> {
  const webhook = configured(process.env.NOTIFY_WEBHOOK_URL);
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      console.error("[flexidata] email webhook failed", res.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[flexidata] email webhook error", error);
    return false;
  }
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
    "Open this link to choose a new one (valid for 1 hour):",
    "",
    link,
    "",
    "If you didn't request this, you can safely ignore this email — your password stays unchanged.",
    "",
    "— The FlexiData team",
  ].join("\n");
  const message = {
    to,
    subject,
    text,
    html: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br/>"),
  };

  const transport = getPasswordResetEmailDeliveryStatus();
  if (transport.provider === "resend") {
    return { delivered: await sendWithResend(message), devMode: false };
  }
  if (transport.provider === "webhook") {
    return { delivered: await sendWithWebhook(message), devMode: false };
  }

  if (process.env.NODE_ENV !== "production") {
    console.info(`[flexidata][dev] Password reset for ${to}: ${link}`);
    return { delivered: true, devMode: true, previewUrl: link };
  }

  console.error(
    `[flexidata] password reset emails cannot be sent in production: ${transport.hint ?? "no email transport is configured"}`,
  );
  return { delivered: false, devMode: false };
}
