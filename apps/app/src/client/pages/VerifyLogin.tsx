import { TOKEN_PATTERN } from "@asksite/core";
import { useEffect, useState } from "react";
import { AuthIntro } from "../components/auth-intro.tsx";
import { Notice } from "../components/feedback.tsx";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { navigate } from "../hooks/use-route.ts";
import { api } from "../lib/api.ts";

/** /login#<token>: signs in only on a button press (some mail scanners run page scripts, §5.2). */
export function VerifyLogin() {
  const heading = usePageHeading<HTMLHeadingElement>("Sign in");
  const [token] = useState(() => location.hash.slice(1));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    history.replaceState(null, "", "/login");
  }, []);

  async function signIn() {
    setBusy(true);
    setError(null);
    const res = await api("POST", "/api/auth/login/verify", { token });
    setBusy(false);
    if (res.ok) navigate("/", { replace: true });
    else setError(res.error.message);
  }

  return (
    <div className="auth">
      <section className="auth-panel">
        <h1 ref={heading} tabIndex={-1} className="page-title">
          Sign in
        </h1>
        {TOKEN_PATTERN.test(token) ? (
          <button type="button" className="btn-primary btn-lg mt-6 w-full" onClick={() => void signIn()} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        ) : (
          <Notice tone="error">This link is not complete. Please open the link in your email again, or ask for a new one.</Notice>
        )}
        {error !== null ? (
          <div role="alert">
            <Notice tone="error">
              {error}{" "}
              <a href="/login" className="link">
                Ask for a new link
              </a>
            </Notice>
          </div>
        ) : null}
      </section>
      <AuthIntro />
    </div>
  );
}
