"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/format";

export function Sheet({
  open,
  onClose,
  children,
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/55 backdrop-blur-[3px] transition-opacity"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center md:bottom-10">
        <div className="pointer-events-auto animate-sheet w-full max-w-[520px] rounded-t-[2rem] border-t border-black/5 bg-paper px-5 pb-8 pt-2 shadow-2xl dark:border-line dark:bg-card md:rounded-[2rem] md:border">
          <div className="mx-auto mb-4 mt-2 h-1.5 w-10 rounded-full bg-zinc-200 dark:bg-white/10" />
          {(title || true) && (
            <div className="mb-4 flex items-center justify-between">
              {title ? (
                <h3 className="font-display text-base font-bold tracking-tight">{title}</h3>
              ) : (
                <span />
              )}
              <button
                onClick={onClose}
                aria-label="Dismiss"
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-black/[0.05] text-zinc-500 transition-all hover:bg-black/10 active:scale-90 dark:bg-white/[0.06] dark:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <div className={cn()}>{children}</div>
        </div>
      </div>
    </div>
  );
}
