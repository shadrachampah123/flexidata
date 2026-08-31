"use client";

import { usePathname } from "next/navigation";
import { BottomNav } from "@/components/bottom-nav";
import { SideNav } from "@/components/side-nav";

// Routes that show the focused auth shell (no app navigation chrome).
const AUTH_ROUTES = ["/login", "/register", "/forgot-password", "/reset-password"];

export function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuth = AUTH_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));

  if (isAuth) {
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
