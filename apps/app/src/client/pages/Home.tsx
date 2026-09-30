import type { SiteSummary } from "@asksite/core";
import { useState, type FormEvent } from "react";
import { TextInput } from "../components/fields.tsx";
import { SecurityCheck } from "../components/security-check.tsx";
import { Notice } from "../components/feedback.tsx";
import { useMe } from "../hooks/use-me.ts";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { onLinkClick } from "../hooks/use-route.ts";
import { api } from "../lib/api.ts";
import { paths } from "../lib/route.ts";

function SignIn() {
  const heading = usePageHeading<HTMLHeadingElement>("Sign in");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
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
    if (res.ok) setSent(true);
    else setError(res.status === 422 ? "Enter an email address, like name@example.com." : res.error.message);
  }

  return (
    <section className="card mx-auto max-w-xl">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Sign in
      </h1>
      {sent ? (
        <div role="status">
          <Notice tone="success">
            If that email has an account, we've sent a link. It can take a few minutes. Didn't get it? Email{" "}
            <a className="link break-all" href={`mailto:${__SUPPORT_EMAIL__}`}>
              {__SUPPORT_EMAIL__}
            </a>
            .
          </Notice>
        </div>
      ) : (
        <form noValidate onSubmit={(e) => void submit(e)}>
          <p className="mt-3">We will email you a link to sign in. No password needed.</p>
          <TextInput id="signin-email" label="Your email address" type="email" autoComplete="email" value={email} onChange={setEmail} errors={error ? [error] : []} />
          <div className="mt-5">
            <SecurityCheck onToken={setToken} resetSignal={resetSignal} />
          </div>
          <button type="submit" className="btn-primary mt-6">
            Email me a sign-in link
          </button>
        </form>
      )}
    </section>
  );
}

function statusOf(site: SiteSummary): string {
  if (site.takenDown) return "Offline";
  if (site.inReview) return "Waiting for approval";
  if (site.live) return "Live";
  return "Draft";
}

function Sites({ sites }: { sites: SiteSummary[] }) {
  const heading = usePageHeading<HTMLHeadingElement>("Your websites");
  return (
    <section>
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Your websites
      </h1>
      <ul className="mt-4 space-y-3">
        {sites.map((site) => (
          <li key={site.id} className="card flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{site.businessName ?? "New website"}</h2>
              <p className="text-slate-700">{statusOf(site)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
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
  if (me.state === "loading") return <p role="status">Loading…</p>;
  if (me.state === "signedOut") return <SignIn />;
  if (me.state === "error") return <Notice tone="error">{me.message}</Notice>;
  return <Sites sites={me.sites} />;
}
