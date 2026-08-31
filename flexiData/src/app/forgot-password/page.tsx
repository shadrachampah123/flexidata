import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = { title: "Reset password — FlexiData" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Forgot password?"
      subtitle="Enter your registered email and we'll send a reset link"
      footerText="Remembered it?"
      footerLink={{ href: "/login", label: "Back to sign in" }}
    >
      <ForgotPasswordForm />
    </AuthCard>
  );
}
