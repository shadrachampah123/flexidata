import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Sign in — FlexiData" };

export default function LoginPage() {
  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to buy data, airtime and manage your wallet"
      footerText="New to FlexiData?"
      footerLink={{ href: "/register", label: "Create free account" }}
    >
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthCard>
  );
}
