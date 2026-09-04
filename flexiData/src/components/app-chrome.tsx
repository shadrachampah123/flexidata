"use client";

import { usePathname } from "next/navigation";
import { BottomNav } from "@/components/bottom-nav";
import { SideNav } from "@/components/side-nav";

// Routes that show the focused auth shell (no app navigation chrome).
const AUTH_ROUTES = ["/login", "/register", "/forgot-password", "/reset-password"];

// Routes rendered as a bare shell. The admin area is server-gated and brings
// its own chrome (see src/app/admin/layout.tsx), so customer navigation must
// not appear there — and the customer nav must never link into it.
const BARE_SHELL_ROUTES = [...AUTH_ROUTES, "/admin"];

export function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isBareShell = BARE_SHELL_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(`${r}/`),
  );

  if (isBareShell) {
    return <main className="min-h-dvh">{children}</main>;
  }

  return (
    <>
      <SideNav />
      <div className="min-h-dvh md:pl-[84px]">
        <main className="mx-auto w-full max-w-[520px] px-4 pb-32 pt-5 md:max-w-[560px] md:pb-16 md:pt-8">
          {children}
        </main>
      </div>
      <BottomNav />
    </>
  );
}
