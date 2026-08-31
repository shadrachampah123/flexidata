import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge-level gate. It only verifies the cookie's HMAC signature + expiry
 * (cheap, no database). Uses the Web Crypto API so it runs on the Edge
 * runtime. Server Components and API routes re-check the session against the
 * `sessions` table, so a revoked/expired session can never act even if it slips
 * past here.
 */

const AUTH_COOKIE = "fd_auth";

const enc = new TextEncoder();

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  const bin = atob(padded);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function hmacVerify(payload: string, signature: string, key: CryptoKey): Promise<boolean> {
  try {
    const sig = b64urlDecode(signature);
    const data = enc.encode(payload);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sig as unknown as BufferSource,
      data as unknown as BufferSource,
    );
    return ok;
  } catch {
    return false;
  }
}

async function readSession(
  token: string | undefined,
  secret: string,
): Promise<{ uid: number; exp: number } | null> {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const key = await importHmacKey(secret);
  if (!(await hmacVerify(payload, sig, key))) return null;
  try {
    const json = new TextDecoder().decode(b64urlDecode(payload));
    const parsed = JSON.parse(json) as { uid: number; exp: number };
    if (typeof parsed.uid !== "number" || typeof parsed.exp !== "number") return null;
    if (parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Routes that must never be reached with a valid session.
const AUTH_PAGES = ["/login", "/register", "/forgot-password", "/reset-password"];

export default async function proxy(req: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  const { pathname } = req.nextUrl;

  // API routes do their own auth; never redirect them (they return JSON).
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const token = req.cookies.get(AUTH_COOKIE)?.value;
  const session = secret ? await readSession(token, secret) : null;

  const isAuthPage = AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Signed in but looking at login/register -> send to home.
  if (session && isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Signed out and looking at an app page -> send to login, preserving target.
  if (!session && !isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on every page route except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest|robots.txt|sitemap.xml).*)"],
};
