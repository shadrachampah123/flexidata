import Link from "next/link";
import { Zap } from "lucide-react";

export function AuthCard({
  title,
  subtitle,
  children,
  footerText,
  footerLink,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footerText: string;
  footerLink: { href: string; label: string };
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-ink shadow-[0_10px_28px_rgba(255,203,5,0.4)]">
            <Zap className="h-7 w-7" strokeWidth={2.6} />
          </span>
          <h1 className="mt-3 font-display text-2xl font-bold tracking-tight">
            Flexi<span className="text-brand-deep dark:text-brand">Data</span>
          </h1>
        </div>

        <div className="rounded-[2rem] border border-black/[0.06] bg-paper p-6 shadow-[0_20px_60px_rgba(0,0,0,0.08)] dark:border-line dark:bg-card">
          <h2 className="font-display text-[19px] font-bold tracking-tight">{title}</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">{subtitle}</p>
          <div className="mt-5">{children}</div>
        </div>

        <p className="mt-5 text-center text-[12px] font-semibold text-zinc-500 dark:text-zinc-400">
          {footerText}{" "}
          <Link href={footerLink.href} className="font-black text-brand-deep underline-offset-2 hover:underline dark:text-brand">
            {footerLink.label}
          </Link>
        </p>

        <p className="mt-6 text-center text-[10px] font-semibold tracking-wide text-zinc-400 dark:text-zinc-600">
          MTN &amp; Telecel data • MoMo &amp; card payments • Instant delivery
        </p>
      </div>
    </div>
  );
}

export function AuthInput({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-black uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </span>
      <input
        {...props}
        className="w-full rounded-xl border border-black/10 bg-white px-3.5 py-3 text-[14px] font-semibold outline-none transition placeholder:font-normal placeholder:text-zinc-400 focus:border-brand focus:ring-2 focus:ring-brand/30 dark:border-line dark:bg-night dark:placeholder:text-zinc-600"
      />
    </label>
  );
}

export function AuthButton({
  loading,
  children,
}: {
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="flex w-full items-center justify-center rounded-xl bg-brand px-4 py-3.5 text-[14px] font-black text-ink shadow-[0_10px_24px_rgba(255,203,5,0.35)] transition active:scale-[0.98] disabled:opacity-60"
    >
      {loading ? "Please wait…" : children}
    </button>
  );
}

export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-3.5 py-2.5 text-[12px] font-bold text-rose-600 dark:text-rose-400">
      {message}
    </div>
  );
}

export function AuthNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-2.5 text-[12px] font-bold text-emerald-600 dark:text-emerald-400">
      {message}
    </div>
  );
}
