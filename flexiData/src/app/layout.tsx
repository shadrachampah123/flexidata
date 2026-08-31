import type { Metadata, Viewport } from "next";
import { Manrope, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { BottomNav } from "@/components/bottom-nav";
import { SideNav } from "@/components/side-nav";
import { APP_NAME, APP_TAGLINE } from "@/lib/constants";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
});

const grotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: `${APP_NAME} — ${APP_TAGLINE}`,
  description:
    "Buy MTN & Telecel data bundles at discounted rates, convert airtime to cash, fund your wallet and earn rewards — all in one sleek app.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fffcf2" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d11" },
  ],
  width: "device-width",
  initialScale: 1,
};

const themeInit = `(function(){try{var t=localStorage.getItem('qv-theme');if(t==='light'){document.documentElement.classList.remove('dark');}else{document.documentElement.classList.add('dark');}}catch(e){document.documentElement.classList.add('dark');}})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
    <head>
    <script dangerouslySetInnerHTML={{ __html: themeInit }} />
    </head>
    <body
      className={`${manrope.variable} ${grotesk.variable} bg-cream font-sans text-[#18191f] antialiased dark:bg-night dark:text-[#f2efe4]`}
    >
    <SideNav />
    <div className="min-h-dvh md:pl-[84px]">
      <main className="mx-auto w-full max-w-[520px] px-4 pb-32 pt-5 md:max-w-[560px] md:pb-16 md:pt-8">
        {children}
      </main>
    </div>
    <BottomNav />
    </body>
    </html>
  );
}
