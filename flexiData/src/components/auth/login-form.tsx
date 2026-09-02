"use client";

import { useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthInput, AuthButton, AuthError, AuthNotice } from "@/components/auth/auth-card";

function LoginFormInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  // Sent here by sign-up when the account was created but the session could
  // not be (needsLogin) — reassure, don't alarm.
  const accountCreated = params.get("created") === "1";

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not sign in");
        setLoading(false);
        return;
      }
      // Hard navigation so every server component re-reads the session.
      router.replace(next);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <AuthError message={error} />
      {accountCreated && !error && (
        <AuthNotice message="Your account was created — sign in to continue." />
      )}
      <AuthInput
        label="Email or phone number"
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
        placeholder="you@example.com or 024 123 4567"
        autoComplete="username"
        required
      />
      <div className="relative">
        <AuthInput
          label="Password"
          type={showPw ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your password"
          autoComplete="current-password"
          required
        />
        <button
          type="button"
          onClick={() => setShowPw((v) => !v)}
          className="absolute right-3 top-[34px] text-[11px] font-black text-brand-deep dark:text-brand"
        >
          {showPw ? "Hide" : "Show"}
        </button>
      </div>
      <div className="flex justify-end">
        <Link href="/forgot-password" className="text-[12px] font-black text-brand-deep hover:underline dark:text-brand">
          Forgot password?
        </Link>
      </div>
      <AuthButton loading={loading}>Sign in</AuthButton>
    </form>
  );
}

export function LoginForm() {
  return (
    <Suspense fallback={null}>
      <LoginFormInner />
    </Suspense>
  );
}
