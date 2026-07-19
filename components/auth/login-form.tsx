// filepath: components/auth/login-form.tsx
"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Loader2, ShieldCheck } from "lucide-react";
import { PasswordInput } from "@/components/auth/password-input";
// import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { loginAction, type LoginState } from "@/lib/auth/actions";

type LoginFormProps = {
  nextPath: string;
  initialError?: string;
  showResetConfirmation?: boolean;
};

export function LoginForm({ nextPath, initialError, showResetConfirmation }: LoginFormProps) {
  const [state, formAction, isPending] = useActionState<LoginState, FormData>(
    loginAction,
    initialError ? { error: initialError } : null,
  );

  return (
    <form className="auth-form" action={formAction} noValidate>
      <input type="hidden" name="next" value={nextPath} />

      {showResetConfirmation ? (
        <div className="auth-banner auth-banner--success" role="status">
          Your password has been updated. Sign in with your new password.
        </div>
      ) : null}

      {state?.error ? (
        <div className="auth-banner auth-banner--error" role="alert">
          {state.error}
        </div>
      ) : null}

      {/* Google sign-in temporarily hidden — the Supabase-hosted OAuth
          client shows the Supabase project URL on the consent screen.
          Re-enable once a custom Google OAuth client is registered with
          AidoForMe branding that supersedes the Supabase-managed one.
          See components/auth/oauth-buttons.tsx for the existing impl. */}
      {/* <OAuthButtons nextPath={nextPath} /> */}

      <label className="auth-field">
        <span>Email address</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          defaultValue={state?.email ?? ""}
          placeholder="you@university.edu"
          disabled={isPending}
        />
      </label>

      <PasswordInput
        label="Password"
        name="password"
        autoComplete="current-password"
        required
        placeholder="At least 8 characters"
        disabled={isPending}
        hint={
          <>
            <Link href="/forgot-password">Forgot password?</Link>
          </>
        }
      />

      <button
        className="button button--primary button--full"
        type="submit"
        disabled={isPending}
      >
        {isPending ? (
          <>
            <Loader2 size={16} className="spin" /> Signing in…
          </>
        ) : (
          "Continue securely"
        )}
      </button>

      <p className="auth-switch">
        New to AidoFor.me? <Link href={`/signup${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`}>Create an account</Link>
      </p>

      <p className="auth-product-note">
        <ShieldCheck size={14} aria-hidden="true" />
        AidoFor.me is a TutorPakar product. Your TutorPakar account works here too.
      </p>
    </form>
  );
}