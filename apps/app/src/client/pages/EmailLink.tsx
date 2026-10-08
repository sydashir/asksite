import { useState, type FormEvent } from "react";
import { AuthIntro } from "../components/auth-intro.tsx";
import { TextInput } from "../components/fields.tsx";
import { SecurityCheck } from "../components/security-check.tsx";
import { Notice } from "../components/feedback.tsx";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { onLinkClick } from "../hooks/use-route.ts";
import { api } from "../lib/api.ts";
import { paths } from "../lib/route.ts";

/**
 * "/login/link": the emailed-link form, the way in without a password ("Forgot your password? Email me a log-in link" on /login).
 * The existing flow, unchanged: known owners get a sign-in link, new addresses a sign-up link (DECIDED 2026-10-07).
 */
export function EmailLink() {
  const heading = usePageHeading<HTMLHeadingElement>("Log in");
  const [email, setEmail] = useState("");
  // The address the link went to, as the server uses it (trimmed and lower-cased); null until a request is accepted.
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

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
          Log in
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
              <p className="page-sub">Enter your email and we'll send you a link.</p>
              <TextInput id="signin-email" label="Your email address" type="email" autoComplete="email" value={email} onChange={setEmail} errors={error ? [error] : []} />
              <div className="mt-5">
                <SecurityCheck onToken={setToken} resetSignal={resetSignal} />
              </div>
              <button type="submit" className="btn-primary btn-lg mt-6 w-full">
                Email me a link
              </button>
            </form>
            <p className="mt-6 text-slate-700">
              <a className="link" href={paths.login()} onClick={onLinkClick}>
                Log in with your password
              </a>
            </p>
            <p className="mt-3 text-slate-700">
              New here?{" "}
              <a className="link" href={paths.signup()} onClick={onLinkClick}>
                Create your account
              </a>
            </p>
          </>
        )}
      </section>
      <AuthIntro />
    </div>
  );
}
