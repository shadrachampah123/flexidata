"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

export function LogoutButton({ full = true }: { full?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Even if the network call fails, clear local state and go to login.
    }
    router.push("/login");
    router.refresh();
  };

  if (!full) {
    return (
      <button
        onClick={logout}
        disabled={busy}
        className="flex items-center gap-2 text-xs font-bold text-rose-500 disabled:opacity-50"
      >
        <LogOut className="h-4 w-4" />
        {busy ? "Signing out…" : "Log out"}
      </button>
    );
  }

  return (
    <button
      onClick={logout}
      disabled={busy}
      className="flex w-full items-center gap-3.5 px-4 py-4 text-left transition-colors hover:bg-rose-500/[0.06] active:bg-rose-500/10 disabled:opacity-60"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 text-rose-500">
        <LogOut className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-bold text-rose-600 dark:text-rose-400">
          {busy ? "Signing out…" : "Log out"}
        </span>
        <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
          Sign out of this device
        </span>
      </span>
    </button>
  );
}
