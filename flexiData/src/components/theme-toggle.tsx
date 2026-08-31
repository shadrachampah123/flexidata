"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/format";

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("qv-theme", next ? "dark" : "light");
    } catch {
      /* noop */
    }
    setDark(next);
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
