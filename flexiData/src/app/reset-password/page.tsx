import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = { title: "Set new password — FlexiData" };

export default function ResetPasswordPage() {
  return (
    <AuthCard
      title="Set a new password"
      subtitle="Choose a strong password you don't use anywhere else"
      footerText="Need a new link?"
      footerLink={{ href: "/forgot-password", label: "Request again" }}
    >
      <ResetPasswordForm />
    </AuthCard>
  );
}
