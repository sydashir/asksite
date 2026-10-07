import type { AdminSiteRow } from "@asksite/core";
import { useState } from "react";
import { Select, TextInput } from "../../../../app/src/client/components/fields.tsx";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { usePageHeading } from "../../../../app/src/client/hooks/use-page-heading.ts";
import { onLinkClick } from "../../../../app/src/client/hooks/use-route.ts";
import { CapNote } from "../CapNote.tsx";
import { useResource } from "../hooks.ts";

const FILTERS = [
  { value: "all", label: "All sites" },
  { value: "live", label: "Live" },
  { value: "in_review", label: "Waiting for review" },
  { value: "taken_down", label: "Taken down" },
  { value: "draft", label: "Drafts" },
];

const status = (site: AdminSiteRow) => (site.takenDown ? "Taken down" : site.inReview ? "Waiting for review" : site.live ? "Live" : "Draft");

export function Sites() {
  const heading = usePageHeading<HTMLHeadingElement>("Sites", "Admin");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const { load } = useResource<{ sites: AdminSiteRow[] }>(`/api/admin/sites?filter=${filter}`);
  const needle = search.trim().toLowerCase();
  const matches = (site: AdminSiteRow) => needle === "" || [site.businessName, site.slug, site.ownerEmail].some((v) => v?.toLowerCase().includes(needle));
  return (
    <section>
      <h1 ref={heading} tabIndex={-1} className="page-title">
        Sites
      </h1>
      <div className="flex flex-wrap gap-x-6">
        <div className="w-full max-w-xs">
          <Select id="site-filter" label="Show" options={FILTERS} value={filter} onChange={(v) => setFilter(v === "" ? "all" : v)} />
        </div>
        <div className="w-full max-w-xs">
          <TextInput id="site-search" label="Search" hint="Business name, web address or owner email." type="search" value={search} onChange={setSearch} />
        </div>
      </div>
      {load.state === "error" ? <Notice tone="error">{load.error.message}</Notice> : null}
      {load.state === "ready" ? (
        <ul className="mt-4 space-y-2">
          {load.data.sites.filter(matches).map((site) => (
            <li key={site.id} className="card flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">{site.businessName ?? "(no name yet)"}</p>
                <p className="text-sm text-slate-700">
                  {site.slug ?? "(no web address)"} · {status(site)} · {site.ownerEmail}
                  {site.ownerDisabled ? " · owner disabled" : ""}
                </p>
              </div>
              <a className="btn-secondary" href={`/sites/${site.id}`} onClick={onLinkClick}>
                Open {site.slug ?? site.businessName ?? "site"}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {load.state === "ready" ? <CapNote count={load.data.sites.length} cap={500} /> : null}
    </section>
  );
}
