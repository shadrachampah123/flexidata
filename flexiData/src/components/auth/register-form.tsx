"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthInput, AuthButton, AuthError } from "@/components/auth/auth-card";
import { groupPhone } from "@/lib/format";

function RegisterFormInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [referralCode, setReferralCode] = useState(params.get("ref") ?? "");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const pwHint =
    password.length === 0
      ? "At least 8 characters with letters and numbers"
      : password.length < 8
        ? "Too short — use at least 8 characters"
        : !/[a-zA-Z]/.test(password) || !/\d/.test(password)
          ? "Include both letters and numbers"
          : "Looks good ✓";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          phone: groupPhone(phone),
          password,
          referralCode: referralCode.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not create account");
        setLoading(false);
        return;
      }
      // The account exists but the session could not be created — a redirect
      // to sign in, never a dead end (and a re-submit is never "email already
      // used", because the server recovers that case on its own).
      if (data.needsLogin) {
        router.replace(`/login?created=1&next=${encodeURIComponent(next)}`);
        return;
      }
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
      <AuthInput
        label="Full name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Ama Serwaa"
        autoComplete="name"
        required
      />
      <AuthInput
        label="Email address"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        autoComplete="email"
        required
      />
      <AuthInput
        label="Mobile money / phone number"
        type="tel"
        value={phone}
        onChange={(e) => setPhone(groupPhone(e.target.value))}
        placeholder="024 123 4567"
        autoComplete="tel"
        required
      />
      <div className="relative">
        <AuthInput
          label="Password"
          type={showPw ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Create a password"
          autoComplete="new-password"
          required
          minLength={8}
        />
        <button
          type="button"
          onClick={() => setShowPw((v) => !v)}
          className="absolute right-3 top-[34px] text-[11px] font-black text-brand-deep dark:text-brand"
        >
          {showPw ? "Hide" : "Show"}
        </button>
      </div>
      <p className={`-mt-2 text-[11px] font-semibold ${password.length >= 8 && /[a-zA-Z]/.test(password) && /\d/.test(password) ? "text-emerald-500" : "text-zinc-400"}`}>
        {pwHint}
      </p>
      <AuthInput
        label="Referral code (optional)"
        value={referralCode}
        onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
        placeholder="FD-FRIEND-1A2B"
      />
      <p className="text-[10.5px] leading-relaxed text-zinc-400 dark:text-zinc-500">
        By creating an account you agree to pay only for what you order. Your wallet starts at
        GH₵ 0.00 — fund it with MTN MoMo, Telecel Cash or card.
      </p>
      <AuthButton loading={loading}>Create free account</AuthButton>
    </form>
  );
}

export function RegisterForm() {
  return (
    <Suspense fallback={null}>
      <RegisterFormInner />
    </Suspense>
  );
}
