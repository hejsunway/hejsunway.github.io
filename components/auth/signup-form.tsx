// filepath: components/auth/signup-form.tsx
"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Loader2, ShieldCheck } from "lucide-react";
import { PasswordInput } from "@/components/auth/password-input";
// import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { signupAction, type SignupState } from "@/lib/auth/actions";

type SignupFormProps = {
  nextPath: string;
};

export function SignupForm({ nextPath }: SignupFormProps) {
  const [state, formAction, isPending] = useActionState<SignupState, FormData>(
    signupAction,
    null,
  );

  return (
    <form className="auth-form" action={formAction} noValidate>
      <input type="hidden" name="next" value={nextPath} />

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
        autoComplete="new-password"
        required
        minLength={8}
        placeholder="At least 8 characters"
        disabled={isPending}
        hint="Use 8+ characters with letters and numbers."
      />

      <PasswordInput
        label="Confirm password"
        name="confirm"
        autoComplete="new-password"
        required
        minLength={8}
        placeholder="Repeat your password"
        disabled={isPending}
      />

      <label className="checkbox-label">
        <input type="checkbox" name="acceptTerms" disabled={isPending} />
        <span>
          I&apos;ll use AidoForMe in line with my course and institution rules.
        </span>
      </label>

      <button
        className="button button--primary button--full"
        type="submit"
        disabled={isPending}
      >
        {isPending ? (
          <>
            <Loader2 size={16} className="spin" /> Creating workspace…
          </>
        ) : (
          "Create workspace"
        )}
      </button>

      <p className="auth-switch">
        Already have an account? <Link href={`/login${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`}>Log in</Link>
      </p>

      <p className="auth-product-note">
        <ShieldCheck size={14} aria-hidden="true" />
        AidoFor.me is a TutorPakar product. One account works across both.
      </p>
    </form>
  );
}