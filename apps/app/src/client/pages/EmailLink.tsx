import { TOKEN_PATTERN } from "@asksite/core";
import { useEffect, useState, type FormEvent } from "react";
import { AuthIntro } from "../components/auth-intro.tsx";
import { TextInput } from "../components/fields.tsx";
import { SecurityCheck } from "../components/security-check.tsx";
import { Notice } from "../components/feedback.tsx";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { onLinkClick } from "../hooks/use-route.ts";
import { api } from "../lib/api.ts";
import { paths } from "../lib/route.ts";

/** The email-link form, on its own page for each way in: "/signup" (new) and "/login" (existing). Both post to the same endpoint. */
export function EmailLink({ mode }: { mode: "signup" | "login" }) {
  const signup = mode === "signup";
  const title = signup ? "Create your account" : "Log in";
  const heading = usePageHeading<HTMLHeadingElement>(title);
  const [email, setEmail] = useState("");
  // The address the link went to, as the server uses it (trimmed and lower-cased); null until a request is accepted.
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  // An emailed link opened in this same tab (/login → /login#token) changes only the hash, which no route change follows: load
  // the page again so the link page (VerifyLogin) opens, as it does in a new tab. Only a real token does this (the skip link
  // "#main" must not).
  useEffect(() => {
    if (signup) return;
    const onHash = () => {
      if (TOKEN_PATTERN.test(location.hash.slice(1))) location.reload();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [signup]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    // No token (not solved yet, or the widget could not load): the Worker refuses and its message is shown.
    const res = await api("POST", "/api/auth/login", { email: email.trim() }, token === null ? {} : { "x-turnstile-token": token });
    // A token works once, so ask for a new one after every try.
    setToken(null);
    setResetSignal((n) => n + 1);
    if (res.ok) setSentTo(email.trim().toLowerCase());
    else setError(res.status === 422 ? "Enter an email address, like name@example.com." : res.error.message);
  }

  return (
    <div className="auth">
      <section className="auth-panel">
        <h1 ref={heading} tabIndex={-1} className="page-title">
          {title}
        </h1>
        {sentTo !== null ? (
          <div role="status">
            <Notice tone="success">
              {/* True for every address (DECIDED 2026-10-07): known owners get a sign-in link, new ones a sign-up link, and a cap may stop either. */}
              If we can send a link to <span className="break-all">{sentTo}</span> right now, it's on its way. It can take a few minutes. Didn't get it? Email{" "}
              <a className="link break-all" href={`mailto:${__SUPPORT_EMAIL__}`}>
                {__SUPPORT_EMAIL__}
              </a>
              .
            </Notice>
          </div>
        ) : (
          <>
            <form noValidate onSubmit={(e) => void submit(e)}>
              <p className="page-sub">{signup ? "Enter your email and we'll send you a link to start. No password needed." : "Enter your email and we'll send you a link."}</p>
              <TextInput id="signin-email" label="Your email address" type="email" autoComplete="email" value={email} onChange={setEmail} errors={error ? [error] : []} />
              <div className="mt-5">
                <SecurityCheck onToken={setToken} resetSignal={resetSignal} />
              </div>
              <button type="submit" className="btn-primary btn-lg mt-6 w-full">
                Email me a link
              </button>
            </form>
            <p className="mt-6 text-slate-700">
              {signup ? "Already have an account? " : "New here? "}
              <a className="link" href={signup ? paths.login() : paths.signup()} onClick={onLinkClick}>
                {signup ? "Log in" : "Create your account"}
              </a>
            </p>
          </>
        )}
      </section>
      <AuthIntro />
    </div>
  );
}
