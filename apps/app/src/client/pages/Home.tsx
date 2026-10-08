import type { SiteSummary } from "@asksite/core";
import { useState, type FormEvent } from "react";
import { AuthIntro } from "../components/auth-intro.tsx";
import { TextInput } from "../components/fields.tsx";
import { SecurityCheck } from "../components/security-check.tsx";
import { Notice } from "../components/feedback.tsx";
import { useMe } from "../hooks/use-me.ts";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { onLinkClick } from "../hooks/use-route.ts";
import { api } from "../lib/api.ts";
import { paths } from "../lib/route.ts";

function SignIn() {
  const heading = usePageHeading<HTMLHeadingElement>("Sign in or sign up");
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
          Sign in or sign up
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
        )}
      </section>
      <AuthIntro />
    </div>
  );
}

function statusOf(site: SiteSummary): string {
  if (site.takenDown) return "Offline";
  if (site.inReview) return "Waiting for approval";
  if (site.live) return "Live";
  return "Draft";
}

/** The status badge's look: green when live, amber while waiting, red when offline, grey for a draft (all AA on their fills). */
const STATUS_PILL: Record<string, string> = {
  Live: "pill-brand",
  "Waiting for approval": "pill bg-amber-100 text-amber-900",
  Offline: "pill bg-red-100 text-red-800",
  Draft: "pill",
};

function Sites({ sites }: { sites: SiteSummary[] }) {
  const heading = usePageHeading<HTMLHeadingElement>("Your websites");
  return (
    <section>
      <h1 ref={heading} tabIndex={-1} className="page-title">
        Your websites
      </h1>
      <p className="page-sub">Pick a website to edit it, check its status or read its messages.</p>
      <ul className="mt-6 grid gap-4 lg:grid-cols-2">
        {sites.map((site) => (
          <li key={site.id} className="card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h2 className="section-title">{site.businessName ?? "New website"}</h2>
              <p>
                <span className={STATUS_PILL[statusOf(site)]}>{statusOf(site)}</span>
              </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <a className="btn-primary" href={paths.edit(site.id)} onClick={onLinkClick}>
                Open
              </a>
              <a className="btn-secondary" href={paths.publish(site.id)} onClick={onLinkClick}>
                Status
              </a>
              <a className="btn-secondary" href={paths.leads(site.id)} onClick={onLinkClick}>
                Messages
              </a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Home() {
  const me = useMe();
  if (me.state === "loading") {
    return (
      <p role="status" className="loading">
        <span className="spinner" aria-hidden="true" />
        Loading…
      </p>
    );
  }
  if (me.state === "signedOut") return <SignIn />;
  if (me.state === "error") return <Notice tone="error">{me.message}</Notice>;
  return <Sites sites={me.sites} />;
}
