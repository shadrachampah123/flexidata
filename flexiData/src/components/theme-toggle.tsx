"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/format";

const THEME_KEY = "flexidata-theme";

function subscribe(onChange: () => void) {
  const el = document.documentElement;
  const observer = new MutationObserver(onChange);
  observer.observe(el, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("storage", onChange);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", onChange);
  };
}

function getSnapshot(): boolean {
  return document.documentElement.classList.contains("dark");
}

function getServerSnapshot(): boolean | null {
  // Unknown on the server — rendered as a neutral placeholder to keep hydration in sync.
  return null;
}

export function ThemeToggle({ className }: { className?: string }) {
  const dark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch {
      /* noop */
    }
  };

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={toggle}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-2xl border border-black/5 bg-white text-[#18191f] shadow-sm transition-all hover:-translate-y-0.5 active:scale-90 dark:border-line dark:bg-card dark:text-[#f2efe4]",
        className,
      )}
    >
      {dark === null ? (
        <Sun className="h-[18px] w-[18px] opacity-0" />
      ) : dark ? (
        <Sun className="h-[18px] w-[18px] text-brand" />
      ) : (
        <Moon className="h-[18px] w-[18px]" />
      )}
    </button>
  );
}
