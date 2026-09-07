"use client";

import { useEffect, useState, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Thin top progress bar that appears *immediately* on navigation so taps feel
 * instant even while the destination Server Component is still streaming.
 *
 * Next.js App Router shows `loading.tsx` instantly after the previous page
 * unmounts, but there is still a brief gap between tap → React startTransition
 * → `loading.tsx` mount where the old screen looks frozen. This bar covers that
 * gap and continues until the new pathname commits.
 *
 * Implementation: intercept clicks on internal <a> / Next <Link> and show bar
 * synchronously before `next/navigation` begins its transition. Also listens
 * for `pathname` changes to clear the bar.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPathRef = useRef(pathname);

  // When pathname actually changes, animate to 100% then hide
  useEffect(() => {
    if (prevPathRef.current !== pathname) {
      prevPathRef.current = pathname;
      // Finish animation
      setWidth(100);
      const t = setTimeout(() => {
        setVisible(false);
        setWidth(0);
      }, 250);
      return () => clearTimeout(t);
    }
  }, [pathname]);

  useEffect(() => {
    const start = () => {
      setVisible(true);
      setWidth(5);
      if (timerRef.current) clearTimeout(timerRef.current);
      // Simulate progress while waiting for server
      timerRef.current = setTimeout(() => setWidth(40), 80);
      const t2 = setTimeout(() => setWidth(72), 350);
      const t3 = setTimeout(() => setWidth(84), 900);
      return () => {
        clearTimeout(t2);
        clearTimeout(t3);
      };
    };

    // Global click handler — starts bar synchronously on any internal navigation
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      // Only internal app routes
      if (href.startsWith("http") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) return;
      if (href.startsWith("/")) {
        // Check if it's same-page hash or already active — don't show
        if (anchor.target === "_blank") return;
        // Modifier keys → new tab behavior, skip
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        // Don't trigger for UIs that handle navigation programmatically
        // (they fire `beforeunload` isn't needed)
        start();
      }
    };

    // Also hook popstate (back/forward buttons)
    const onPop = () => start();

    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed left-0 right-0 top-0 z-[9999] h-[3px] pointer-events-none">
      <div
        className="h-full bg-brand transition-all duration-300 ease-out"
        style={{
          width: `${width}%`,
          boxShadow: "0 0 8px rgba(255,203,5,0.8)",
          transition: width === 100 ? "width 180ms ease-out" : "width 600ms cubic-bezier(0.4,0,0.2,1)",
        }}
      />
    </div>
  );
}
