"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthInput, AuthButton, AuthError, AuthNotice } from "@/components/auth/auth-card";

function ResetPasswordFormInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      setError("Password needs at least 8 characters with letters and numbers");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not reset password");
        setLoading(false);
        return;
      }
      setNotice(data.message ?? "Password updated. Redirecting to sign in…");
      setDone(true);
      setTimeout(() => router.replace("/login"), 1800);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="space-y-4">
        <AuthError message="This link has no token. Request a new password reset email." />
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <AuthError message={error} />
      <AuthNotice message={notice} />
      <AuthInput
        label="New password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="At least 8 characters"
        autoComplete="new-password"
        required
        minLength={8}
        disabled={done}
      />
      <AuthInput
        label="Confirm new password"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="Type it again"
        autoComplete="new-password"
        required
        minLength={8}
        disabled={done}
      />
      <AuthButton loading={loading}>Set new password</AuthButton>
    </form>
  );
}

export function ResetPasswordForm() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordFormInner />
    </Suspense>
  );
}
