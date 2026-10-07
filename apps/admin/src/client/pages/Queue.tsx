import type { AdminSiteRow, VersionSummary } from "@asksite/core";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { usePageHeading } from "../../../../app/src/client/hooks/use-page-heading.ts";
import { onLinkClick } from "../../../../app/src/client/hooks/use-route.ts";
import { CapNote } from "../CapNote.tsx";
import { useResource } from "../hooks.ts";
import { when } from "../lib/format.ts";

/** Versions waiting for a human, oldest first (§3.2 step 3). */
export function Queue() {
  const heading = usePageHeading<HTMLHeadingElement>("Waiting for review", "Admin");
  const { load } = useResource<{ items: Array<{ version: VersionSummary; site: AdminSiteRow }> }>("/api/admin/reviews");
  return (
    <section>
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Waiting for review
      </h1>
      {load.state === "loading" ? <p role="status">Loading…</p> : null}
      {load.state === "error" ? <Notice tone="error">{load.error.message}</Notice> : null}
      {load.state === "ready" && load.data.items.length === 0 ? <p className="mt-4">Nothing is waiting for review.</p> : null}
      {load.state === "ready" && load.data.items.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {load.data.items.map(({ version, site }) => (
            <li key={version.id} className="card flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{site.businessName ?? "(no name)"}</h2>
                <p className="text-slate-700">
                  {site.slug} · version {version.number} · sent {when(version.requestedAt)} · {site.ownerEmail}
                </p>
              </div>
              <a className="btn-primary" href={`/reviews/${version.id}`} onClick={onLinkClick}>
                Review {site.slug ?? "site"} version {version.number}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {load.state === "ready" ? <CapNote count={load.data.items.length} cap={50} order="oldest" /> : null}
    </section>
  );
}
