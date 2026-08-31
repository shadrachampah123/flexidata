"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/format";

/**
 * Anchored dropdown surface rendered in a portal on <body>.
 *
 * Why a portal: `.animate-fade-up` runs a transform keyframe with
 * `animation-fill-mode: both`, so the transform sticks around forever after the
 * animation finishes. A lingering transform makes the element BOTH a stacking
 * context and the containing block for `position: fixed` descendants. Any menu
 * rendered inside one of those wrappers is therefore trapped: its `z-50` only
 * competes with its siblings, so later siblings (the sticky checkout bar, the
 * promo ticker, the wallet card) paint on top of it, and a `fixed inset-0`
 * backdrop shrinks to the wrapper instead of covering the viewport.
 *
 * Escaping to <body> sidesteps all of that: the panel lands in the root
 * stacking context, above the navs (z-40) and below the modal sheet (z-60).
 */
export function DropdownPanel({
  open,
  anchorRef,
  onClose,
  children,
  align = "stretch",
  width,
  maxHeight = 320,
  className,
  label,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  /** stretch = match anchor width, left/right = align that edge and use `width` */
  align?: "stretch" | "left" | "right";
  width?: number;
  maxHeight?: number;
  className?: string;
  label?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    flipped: boolean;
  } | null>(null);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const r = anchor.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const w = align === "stretch" ? r.width : Math.min(width ?? r.width, vw - margin * 2);

    let left: number;
    if (align === "right") left = r.right - w;
    else left = r.left;
    // keep the panel inside the viewport on narrow screens
    left = Math.min(Math.max(margin, left), Math.max(margin, vw - w - margin));

    const spaceBelow = vh - r.bottom - gap - margin;
    const spaceAbove = r.top - gap - margin;
    // only flip up when below is genuinely cramped and above is roomier
    const flipped = spaceBelow < Math.min(maxHeight, 200) && spaceAbove > spaceBelow;

    const available = Math.max(120, flipped ? spaceAbove : spaceBelow);
    const h = Math.min(maxHeight, available);

    setPos({
      top: flipped ? r.top - gap - h : r.bottom + gap,
      left,
      width: w,
      maxHeight: h,
      flipped,
    });
  }, [align, anchorRef, maxHeight, width]);

  // Runs before paint, so the panel is never shown at a stale position.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  // Keep the panel glued to its anchor while the page scrolls or resizes.
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const onChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
    };
  }, [open, measure]);

  // Dismiss on outside pointer press or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return; // let the trigger toggle itself
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchorRef.current?.focus?.();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, anchorRef]);

  // `open` always starts false, so server and first client render agree on null.
  if (!open || !pos || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      role="listbox"
      aria-label={label}
      style={{
        top: pos.top,
        left: pos.left,
        width: pos.width,
        maxHeight: pos.maxHeight,
      }}
      className={cn(
        "animate-fade-up fixed z-50 flex flex-col overflow-hidden overscroll-contain rounded-2xl border border-black/[0.06] bg-paper shadow-[0_20px_50px_rgba(0,0,0,0.18)] dark:border-line dark:bg-card2",
        className,
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </div>,
    document.body,
  );
}
