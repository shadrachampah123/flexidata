"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Client-side freshness guard for money surfaces (mounted on /wallet and /).
 *
 * The Wallet page reads the balance straight from the database on every server
 * render — the server side is never stale. The one layer that CAN go stale is
 * the browser's client-side Router Cache: after /wallet (or /) has been
 * visited, the App Router may serve its cached RSC payload for a short window
 * instead of re-requesting the page, and money mutations performed OUT OF BAND
 * (an admin rejecting and refunding a withdrawal, a Paystack webhook settling
 * a deposit, an incoming transfer) can never invalidate a cache that lives in
 * someone else's browser.
 *
 * So whenever a money surface (re)appears in front of the user — on mount
 * (which covers every client-side navigation), when the tab regains focus,
 * when the page becomes visible again, and when it is restored from the
 * browser back/forward cache — we compare the LIVE balance from the
 * `no-store` `GET /api/wallet` endpoint against the server-rendered balance,
 * and if they differ we call `router.refresh()`. That re-renders the Server
 * Components from the database, so every server-rendered figure on the page
 * (header chip, WalletCard, withdrawal list) converges on the truth without a
 * log-out/log-in or a hard reload.
 *
 * Deliberately does NOT mutate any displayed value client-side: the server
 * stays the single source of truth for money. When the balances match (the
 * overwhelmingly common case) it does nothing at all.
 */
export function WalletFreshness({ serverBalance }: { serverBalance: number }) {
  const router = useRouter();
  /**
   * Latest server-rendered balance, kept current across refreshes. Written
   * inside the effect below (never during render) so the async check always
   * compares against the freshest server figure.
   */
  const serverBalanceRef = useRef(serverBalance);
  /** Guards against overlapping checks (focus + visibility fire together). */
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Track the latest server-rendered balance (ref writes are allowed in
    // effects) so a refresh triggered by an earlier check doesn't compare
    // against a figure that has since been re-rendered.
    serverBalanceRef.current = serverBalance;

    const check = async () => {
      if (inFlightRef.current || document.visibilityState === "hidden") return;
      inFlightRef.current = true;
      try {
        const res = await fetch("/api/wallet", {
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
        });
        if (!res.ok) return; // signed out / offline: pages redirect on their own
        const data = (await res.json()) as { ok?: boolean; wallet?: { balance?: number } };
        if (cancelled || !data.ok || typeof data.wallet?.balance !== "number") return;
        if (data.wallet.balance !== serverBalanceRef.current) {
          // Money moved (in or out of band) since this page was rendered —
          // re-render the Server Components from the database.
          router.refresh();
        }
      } catch {
        // Network hiccup: the next mount/focus/visibility check retries.
      } finally {
        inFlightRef.current = false;
      }
    };

    const onGainAttention = () => {
      if (document.visibilityState === "visible") void check();
    };
    // Restored from the browser back/forward cache: the whole page — including
    // its rendered balances — is a snapshot from when it was cached.
    const onPageShow = (event: Event) => {
      if ((event as PageTransitionEvent).persisted) void check();
    };

    void check();
    window.addEventListener("focus", onGainAttention);
    document.addEventListener("visibilitychange", onGainAttention);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onGainAttention);
      document.removeEventListener("visibilitychange", onGainAttention);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [router, serverBalance]);

  return null;
}
