import type { SiteSummary } from "@asksite/core";
import { lazy, Suspense } from "react";
import { Notice } from "../components/feedback.tsx";
import { useMe } from "../hooks/use-me.ts";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { onLinkClick } from "../hooks/use-route.ts";
import { paths } from "../lib/route.ts";

const Landing = lazy(() => import("../landing/Landing.tsx"));

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
  if (me.state === "signedOut") {
    return (
      <Suspense
        fallback={
          <p role="status" className="loading">
            <span className="spinner" aria-hidden="true" />
            Loading…
          </p>
        }
      >
        <Landing />
      </Suspense>
    );
  }
  if (me.state === "error") return <Notice tone="error">{me.message}</Notice>;
  return <Sites sites={me.sites} />;
}
