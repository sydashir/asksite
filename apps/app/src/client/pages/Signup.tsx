import { useState, type FormEvent } from "react";
import { AuthIntro } from "../components/auth-intro.tsx";
import { Notice } from "../components/feedback.tsx";
import { PasswordInput, TextInput } from "../components/fields.tsx";
import { SecurityCheck } from "../components/security-check.tsx";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { navigate, onLinkClick } from "../hooks/use-route.ts";
import { api } from "../lib/api.ts";
import { NEW_PASSWORD_HINT, passwordProblem } from "../lib/password.ts";
import { paths } from "../lib/route.ts";

/**
 * "/signup": email, password and the security check (USER ORDER 2026-10-08). The Worker makes the account and the site and
 * signs in at once (no email), so the questionnaire opens next. An email with an account gets the Worker's answer with both
 * ways in: log in, or the emailed link.
 */
export function Signup() {
  const heading = usePageHeading<HTMLHeadingElement>("Create your account");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; exists: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setEmailError(null);
    setError(null);
    const problem = passwordProblem(password);
    setPasswordError(problem);
    if (problem !== null) return;
    setBusy(true);
    const res = await api<{ siteId: string }>("POST", "/api/auth/signup", { email: email.trim(), password }, token === null ? {} : { "x-turnstile-token": token });
    setBusy(false);
    // A token works once, so ask for a new one after every try.
    setToken(null);
    setResetSignal((n) => n + 1);
    if (res.ok) navigate(paths.setup(res.data.siteId, "business"), { replace: true });
    else if (res.status === 422) setEmailError("Enter an email address, like name@example.com.");
    else setError({ message: res.error.message, exists: res.status === 409 });
  }

  return (
    <div className="auth">
      <section className="auth-panel">
        <h1 ref={heading} tabIndex={-1} className="page-title">
          Create your account
        </h1>
        <form noValidate onSubmit={(e) => void submit(e)}>
          <p className="page-sub">Make a website for your business. Choose a password to log in with.</p>
          <TextInput id="signup-email" label="Your email address" type="email" autoComplete="email" value={email} onChange={setEmail} errors={emailError ? [emailError] : []} />
          <PasswordInput
            id="signup-password"
            label="Password"
            hint={NEW_PASSWORD_HINT}
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            errors={passwordError ? [passwordError] : []}
          />
          <div className="mt-5">
            <SecurityCheck onToken={setToken} resetSignal={resetSignal} />
          </div>
          {error !== null ? (
            <div role="alert">
              <Notice tone="error">
                {error.message}
                {error.exists ? (
                  <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    <a className="link" href={paths.login()} onClick={onLinkClick}>
                      Log in
                    </a>
                    <a className="link" href={paths.loginLink()} onClick={onLinkClick}>
                      Email me a log-in link
                    </a>
                  </span>
                ) : null}
              </Notice>
            </div>
          ) : null}
          <button type="submit" className="btn-primary btn-lg mt-6 w-full" disabled={busy}>
            {busy ? "Creating your account…" : "Create account"}
          </button>
        </form>
        <p className="mt-6 text-slate-700">
          Already have an account?{" "}
          <a className="link" href={paths.login()} onClick={onLinkClick}>
            Log in
          </a>
        </p>
      </section>
      <AuthIntro />
    </div>
  );
}
