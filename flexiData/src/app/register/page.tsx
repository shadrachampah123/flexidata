import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = { title: "Create account — FlexiData" };

export default function RegisterPage() {
  return (
    <AuthCard
      title="Create your account"
      subtitle="Free forever — buy cheap MTN & Telecel data in seconds"
      footerText="Already have an account?"
      footerLink={{ href: "/login", label: "Sign in" }}
    >
      <RegisterForm />
    </AuthCard>
  );
}
