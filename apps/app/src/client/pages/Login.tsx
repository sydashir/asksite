import { TOKEN_PATTERN } from "@asksite/core";
import { useEffect, useState, type FormEvent } from "react";
import { AuthIntro } from "../components/auth-intro.tsx";
import { Notice } from "../components/feedback.tsx";
import { PasswordInput, TextInput } from "../components/fields.tsx";
import { SecurityCheck } from "../components/security-check.tsx";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { navigate, onLinkClick } from "../hooks/use-route.ts";
import { api } from "../lib/api.ts";
import { paths } from "../lib/route.ts";

/**
 * "/login": email and password (USER ORDER 2026-10-08). A wrong email or password, and the 5-try lock, get the Worker's one
 * generic answer; the lock also offers the emailed link, which always works. "Forgot your password?" leads to the link form.
 */
export function Login() {
  const heading = usePageHeading<HTMLHeadingElement>("Log in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; locked: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  // An emailed link opened in this same tab (/login → /login#token) changes only the hash, which no route change follows: load
  // the page again so the link page (VerifyLogin) opens, as it does in a new tab. Only a real token does this (the skip link
  // "#main" must not).
  useEffect(() => {
    const onHash = () => {
      if (TOKEN_PATTERN.test(location.hash.slice(1))) location.reload();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setEmailError(null);
    setError(null);
    setBusy(true);
    const res = await api("POST", "/api/auth/login/password", { email: email.trim(), password }, token === null ? {} : { "x-turnstile-token": token });
    setBusy(false);
    // A token works once, so ask for a new one after every try.
    setToken(null);
    setResetSignal((n) => n + 1);
    if (res.ok) navigate(paths.home(), { replace: true });
    else if (res.status === 422) setEmailError("Enter an email address and your password.");
    else setError({ message: res.error.message, locked: res.error.code === "login_locked" });
  }

  return (
    <div className="auth">
      <section className="auth-panel">
        <h1 ref={heading} tabIndex={-1} className="page-title">
          Log in
        </h1>
        <form noValidate onSubmit={(e) => void submit(e)}>
          <p className="page-sub">Enter your email and password.</p>
          <TextInput id="login-email" label="Your email address" type="email" autoComplete="email" value={email} onChange={setEmail} errors={emailError ? [emailError] : []} />
          <PasswordInput id="login-password" label="Password" autoComplete="current-password" value={password} onChange={setPassword} />
          <div className="mt-5">
            <SecurityCheck onToken={setToken} resetSignal={resetSignal} />
          </div>
          {error !== null ? (
            <div role="alert">
              <Notice tone="error">
                {error.message}
                {error.locked ? (
                  <>
                    {" "}
                    <a className="link" href={paths.loginLink()} onClick={onLinkClick}>
                      Email me a log-in link
                    </a>
                  </>
                ) : null}
              </Notice>
            </div>
          ) : null}
          <button type="submit" className="btn-primary btn-lg mt-6 w-full" disabled={busy}>
            {busy ? "Logging in…" : "Log in"}
          </button>
        </form>
        <p className="mt-6 text-slate-700">
          Forgot your password?{" "}
          <a className="link" href={paths.loginLink()} onClick={onLinkClick}>
            Email me a log-in link
          </a>
        </p>
        <p className="mt-3 text-slate-700">
          New here?{" "}
          <a className="link" href={paths.signup()} onClick={onLinkClick}>
            Create your account
          </a>
        </p>
      </section>
      <AuthIntro />
    </div>
  );
}
