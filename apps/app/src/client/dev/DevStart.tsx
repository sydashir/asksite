import { usePageHeading } from "../hooks/use-page-heading.ts";
import { onLinkClick } from "../hooks/use-route.ts";
import { adminOrigin } from "./admin-origin.ts";

/** The sign-up page. */
export const SIGN_UP_HREF = "/signup";

export function DevStart() {
  const heading = usePageHeading<HTMLHeadingElement>("Demo start");
  const admin = adminOrigin(location);
  return (
    <section className="mx-auto max-w-5xl">
      <h1 ref={heading} tabIndex={-1} className="page-title">
        Demo start
      </h1>
      <p className="dev-box mt-3">Development only. Shortcuts for trying the whole journey on this computer. This page is not in the live app.</p>
      <ul className="mt-6 grid gap-4 lg:grid-cols-3">
        <li className="card flex flex-col gap-3">
          <h2 className="section-title">New client</h2>
          <p>Sign up with any email address and a password, answer the questions and build a website, as a client would. If you are signed in, sign out first.</p>
          <a href={SIGN_UP_HREF} onClick={onLinkClick} className="btn-primary mt-auto">
            Sign up as a new client
          </a>
        </li>
        <li className="card flex flex-col gap-3">
          <h2 className="section-title">Hybrid team</h2>
          <p>Review and approve websites. On this computer you are signed in as the development admin.</p>
          {admin !== null ? (
            <a href={`${admin}/`} className="btn-secondary mt-auto">
              Open admin
            </a>
          ) : (
            <p className="meta">The admin address could not be worked out from this page's address. Open the admin app on its own port.</p>
          )}
        </li>
        <li className="card flex flex-col gap-3">
          <h2 className="section-title">Emails</h2>
          <p>Sign-in links, invites and review results land here instead of being sent.</p>
          <a href="/dev/inbox" onClick={onLinkClick} className="btn-secondary mt-auto">
            Open the local inbox
          </a>
        </li>
      </ul>
      <h2 className="section-title mt-10">A full demo, step by step</h2>
      <ol className="mt-3 list-decimal space-y-2 pl-6">
        <li>Sign up as a new client with an email address and a password.</li>
        <li>Answer the questions and build the website.</li>
        <li>Edit anything you like, then send it for review.</li>
        <li>Open admin, look at every page of the review, then approve it.</li>
        <li>Open the live website and send a message through its contact form.</li>
      </ol>
    </section>
  );
}
