// filepath: app/login/page.tsx
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { safeInternalPath } from "@/lib/auth/safe-redirect";

export const metadata: Metadata = {
  title: "Log in",
  robots: { index: false, follow: false },
};

const ERROR_MESSAGES: Record<string, string> = {
  exchange_failed:
    "That sign-in link has expired or already been used. Request a new one or sign in with your email and password.",
};

type SearchParams = Promise<{
  next?: string;
  error?: string;
  message?: string;
  reset?: string;
  confirmed?: string;
  email?: string;
}>;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const nextPath = safeInternalPath(params.next, "/app");
  const errorCode = params.error ?? "";
  const errorMessage =
    ERROR_MESSAGES[errorCode] ??
    (params.message ? decodeURIComponent(params.message) : undefined);
  const showResetConfirmation = params.reset === "1";
  const showSignupConfirmation = params.confirmed === "1" && Boolean(params.email);

  return (
    <AuthShell mode="login">
      {showSignupConfirmation ? (
        <div className="auth-banner auth-banner--success" role="status">
          We sent a confirmation link to <b>{params.email}</b>. Open it on this device to
          verify your email, then sign in.
        </div>
      ) : null}
      <LoginForm
        nextPath={nextPath}
        initialError={errorMessage}
        showResetConfirmation={showResetConfirmation}
      />
    </AuthShell>
  );
}
