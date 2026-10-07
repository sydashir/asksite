import { TOKEN_PATTERN } from "@asksite/core";
import { useEffect, useState } from "react";
import { AuthIntro } from "../components/auth-intro.tsx";
import { Notice } from "../components/feedback.tsx";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { navigate } from "../hooks/use-route.ts";
import { api } from "../lib/api.ts";
import { paths } from "../lib/route.ts";

/**
 * /invite#<token>. The token is read from the fragment (never sent in a URL to any server) and
 * used only when the owner presses the button, so email scanners that open links do not spend it
 * (§3.1 step 2, §5.2).
 */
export function AcceptInvite() {
  const heading = usePageHeading<HTMLHeadingElement>("Set up your website");
  const [token] = useState(() => location.hash.slice(1));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    history.replaceState(null, "", "/invite");
  }, []);

  async function accept() {
    setBusy(true);
    setError(null);
    const res = await api<{ siteId: string }>("POST", "/api/auth/invite/accept", { token });
    setBusy(false);
    if (res.ok) navigate(paths.setup(res.data.siteId, "business"), { replace: true });
    else setError(res.error.message);
  }

  return (
    <div className="auth">
      <section className="auth-panel">
        <h1 ref={heading} tabIndex={-1} className="page-title">
          Set up your website
        </h1>
        {TOKEN_PATTERN.test(token) ? (
          <>
            <p className="page-sub">
              Build a website for your business. It takes about 15 minutes, and you can stop and come back at any time.
            </p>
            <button type="button" className="btn-primary btn-lg mt-6 w-full" onClick={() => void accept()} disabled={busy}>
              {busy ? "Setting up…" : "Set up my website"}
            </button>
          </>
        ) : (
          <Notice tone="error">This link is not complete. Please open the link in your invite email again.</Notice>
        )}
        {error !== null ? (
          <div role="alert">
            <Notice tone="error">{error}</Notice>
          </div>
        ) : null}
      </section>
      <AuthIntro />
    </div>
  );
}
