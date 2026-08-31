"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthInput, AuthButton, AuthError, AuthNotice } from "@/components/auth/auth-card";
import { Mail } from "lucide-react";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setDevLink(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not send reset email");
        setLoading(false);
        return;
      }
      setNotice(data.message ?? "Check your email for the reset link.");
      if (data.devPreviewUrl) setDevLink(data.devPreviewUrl);
      setLoading(false);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <AuthError message={error} />
      <AuthNotice message={notice} />
      {devLink && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-3 text-[11.5px] leading-relaxed">
          <p className="font-black text-amber-600 dark:text-amber-400">Development mode</p>
          <p className="mt-1 font-semibold text-zinc-600 dark:text-zinc-300">
            No email service is configured, so here is the reset link directly:
          </p>
          <Link href={devLink} className="mt-1.5 block break-all font-black text-brand-deep underline dark:text-brand">
            {devLink}
          </Link>
        </div>
      )}
      <AuthInput
        label="Registered email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        autoComplete="email"
        required
      />
      <div className="flex items-center gap-2 text-[11px] text-zinc-400">
        <Mail className="h-3.5 w-3.5" />
        The link expires in 1 hour.
      </div>
      <AuthButton loading={loading}>Send reset link</AuthButton>
    </form>
  );
}
