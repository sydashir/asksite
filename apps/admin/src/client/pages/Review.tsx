import type { AdminVersionDetail } from "@asksite/core";
import { isSafeUrl } from "@asksite/site-schema";
import { useRef, useState, type FormEvent } from "react";
import { Checkbox, TextArea } from "../../../../app/src/client/components/fields.tsx";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { usePageHeading } from "../../../../app/src/client/hooks/use-page-heading.ts";
import { onLinkClick } from "../../../../app/src/client/hooks/use-route.ts";
import { api } from "../../../../app/src/client/lib/api.ts";
import { ReviewPreview } from "../ReviewPreview.tsx";
import { useResource } from "../hooks.ts";
import { flatten, textChanges } from "../lib/diff.ts";
import { FLAG_REASON, when } from "../lib/format.ts";

/** The text of an owner-edited path; service descriptions are keyed by service name (§2.8). */
function editedText(document: unknown, path: string): string {
  const values = flatten(document);
  const service = /^copy\.serviceDescriptions\.(.+)$/.exec(path)?.[1];
  if (service !== undefined) {
    for (let i = 0; values.has(`copy.serviceDescriptions.${i}.service`); i += 1) {
      if (values.get(`copy.serviceDescriptions.${i}.service`) === service) return values.get(`copy.serviceDescriptions.${i}.description`) ?? "";
    }
    return "";
  }
  if (values.has(path)) return values.get(path) ?? "";
  return [...values].filter(([key]) => key.startsWith(`${path}.`)).map(([, value]) => value).join(" / ");
}

/** Thumbnails of the photos on the page, with the owner's alt text as their alt text. */
function PhotoStrip({ document }: { document: unknown }) {
  const facts = (document as { facts?: { heroPhoto?: { url: string; alt: string }; photos?: Array<{ url: string; alt: string }> } }).facts;
  const photos = [...(facts?.heroPhoto === undefined ? [] : [facts.heroPhoto]), ...(facts?.photos ?? [])].filter((p) => isSafeUrl(p.url, ["https:"]));
  if (photos.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {photos.map((photo) => (
        <li key={photo.url}>
          <img src={photo.url} alt={photo.alt} className="h-16 w-20 rounded border border-slate-300 object-cover" />
        </li>
      ))}
    </ul>
  );
}

export function Review({ versionId }: { versionId: string }) {
  const { load, reload } = useResource<AdminVersionDetail>(`/api/admin/versions/${versionId}`);
  if (load.state === "loading") return <p role="status">Loading…</p>;
  if (load.state === "error") return <Notice tone="error">{load.error.message}</Notice>;
  return <ReviewScreen detail={load.data} onDone={() => void reload()} />;
}

function ReviewScreen({ detail, onDone }: { detail: AdminVersionDetail; onDone: () => void }) {
  const { version, site, checks } = detail;
  const title = `Review ${site.businessName ?? site.slug ?? "site"} (version ${version.number})`;
  const heading = usePageHeading<HTMLHeadingElement>(title, "Admin");
  const [phone, setPhone] = useState(false);
  const [approveNote, setApproveNote] = useState("");
  const [indexable, setIndexable] = useState(true);
  const [rejectNote, setRejectNote] = useState("");
  const [rejectError, setRejectError] = useState<string[]>([]);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string; href?: string } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const changes = detail.liveDocument === null ? [] : textChanges(detail.liveDocument, detail.document);
  const pending = version.status === "pending";
  const email = (detail.document as { facts?: { email?: unknown } }).facts?.email;
  const publicEmail = typeof email === "string" ? email : "(none)";
  /** Approve and Reject remove their own forms: keep keyboard focus on the result. */
  const showResult = (value: { tone: "success" | "error"; text: string; href?: string }) => {
    setResult(value);
    requestAnimationFrame(() => resultRef.current?.focus());
  };

  async function approve(event: FormEvent) {
    event.preventDefault();
    const res = await api<{ liveUrl: string }>("POST", `/api/admin/versions/${version.id}/approve`, { htmlSha256: version.htmlSha256, note: approveNote.trim(), indexable });
    if (res.ok) showResult({ tone: "success", text: "Approved. We'll email the owner. The site goes live within about a minute:", href: res.data.liveUrl });
    else showResult({ tone: "error", text: res.error.message });
    onDone();
  }

  async function reject(event: FormEvent) {
    event.preventDefault();
    if (rejectNote.trim() === "") {
      setRejectError(["Write a note for the owner."]);
      document.getElementById("reject-note")?.focus();
      return;
    }
    setRejectError([]);
    const res = await api("POST", `/api/admin/versions/${version.id}/reject`, { note: rejectNote.trim() });
    showResult(res.ok ? { tone: "success", text: "Rejected. We'll email the owner your note." } : { tone: "error", text: res.error.message });
    onDone();
  }

  return (
    <section>
      <p>
        <a href="/" onClick={onLinkClick} className="link">
          Back to the review queue
        </a>
      </p>
      <h1 ref={heading} tabIndex={-1} className="mt-2 text-2xl font-bold">
        {title}
      </h1>
      <p className="mt-1 text-slate-700">
        {site.slug} · {site.ownerEmail} · {checks.firstPublish ? "First publish" : "Update to a live site"} · sent {when(version.requestedAt)} · status {version.status}
      </p>
      {site.ownerDisabled ? <Notice tone="warning">The owner's account is disabled. Approving still publishes this page.</Notice> : null}
      <div ref={resultRef} role="status" tabIndex={-1}>
        {result !== null ? (
          <Notice tone={result.tone}>
            {result.text}{" "}
            {result.href === undefined ? null : isSafeUrl(result.href, ["https:"]) ? (
              <a className="link break-all" href={result.href}>
                {result.href}
              </a>
            ) : (
              <span className="break-all">{result.href}</span>
            )}
          </Notice>
        ) : null}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">The exact page that will go live</h2>
            <div className="flex gap-2" role="group" aria-label="Page width">
              <button type="button" className="btn-small" aria-pressed={!phone} onClick={() => setPhone(false)}>
                Desktop width
              </button>
              <button type="button" className="btn-small" aria-pressed={phone} onClick={() => setPhone(true)}>
                Phone width
              </button>
            </div>
          </div>
          <ReviewPreview src={detail.pageUrl} phone={phone} />
        </div>

        <div className="min-w-0 space-y-6">
          <section className="card" aria-labelledby="checks-title">
            <h2 id="checks-title" className="text-lg font-semibold">
              Checks
            </h2>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="font-medium">Reviews</dt>
              <dd>
                {checks.testimonials}
                {/* Sending needs the confirmation for the reviews as they are (decision 38), so this version had it. */}
                {checks.testimonials > 0
                  ? checks.reviewsAttested
                    ? " (the owner confirmed they are real customers' words when sending)"
                    : " (the owner confirmed them when sending, and has changed the reviews or the confirmation since)"
                  : null}
              </dd>
              <dt className="font-medium">Public email</dt>
              <dd className="break-all">{publicEmail}</dd>
              <dt className="font-medium">Photos</dt>
              <dd>
                {checks.photoCount}
                <PhotoStrip document={detail.document} />
              </dd>
              <dt className="font-medium">Hidden sections</dt>
              <dd>{checks.hiddenSections.length === 0 ? "None" : checks.hiddenSections.join(", ")}</dd>
              <dt className="font-medium">Social links</dt>
              <dd>{checks.socialHosts.length === 0 ? "None" : checks.socialHosts.join(", ")}</dd>
              <dt className="font-medium">Starter wording</dt>
              <dd>{checks.usedFallbackCopy ? "Yes (the AI was not used)" : "No"}</dd>
              <dt className="font-medium">Web address flags</dt>
              <dd>{checks.slugFlags.length === 0 ? "None" : checks.slugFlags.join(", ")}</dd>
            </dl>
            <h3 className="mt-4 font-semibold">Text to look at</h3>
            {checks.textFlags.length === 0 ? (
              <p>Nothing flagged.</p>
            ) : (
              <ul className="mt-1 list-disc pl-5">
                {checks.textFlags.map((flag, i) => (
                  <li key={`${flag.path}-${flag.reason}-${i}`}>
                    <span className="font-mono text-sm">{flag.path}</span> {FLAG_REASON[flag.reason]}: “{editedText(detail.document, flag.path)}”
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="edited-title">
            <h2 id="edited-title" className="text-lg font-semibold">
              Wording the owner changed
            </h2>
            {detail.ownerEditedPaths.length === 0 ? (
              <p>None: all wording is from the AI draft.</p>
            ) : (
              <ul className="mt-1 list-disc pl-5">
                {detail.ownerEditedPaths.map((path) => (
                  <li key={path}>
                    <span className="font-mono text-sm">{path}</span>: “{editedText(detail.document, path)}”
                  </li>
                ))}
              </ul>
            )}
          </section>

          {detail.liveDocument !== null ? (
            <section className="card" aria-labelledby="changes-title">
              <h2 id="changes-title" className="text-lg font-semibold">
                Changes since the live version
              </h2>
              {changes.length === 0 ? (
                <p>No changes.</p>
              ) : (
                <ul className="mt-1 space-y-2">
                  {changes.map((change) => (
                    <li key={change.path}>
                      <span className="font-mono text-sm">{change.path}</span>
                      <span className="block">Before: {change.before ?? "(none)"}</span>
                      <span className="block">After: {change.after ?? "(none)"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {pending ? (
            <>
              <form className="card" noValidate onSubmit={(e) => void approve(e)} aria-labelledby="approve-title">
                <h2 id="approve-title" className="text-lg font-semibold">
                  Approve
                </h2>
                <TextArea id="approve-note" label="Internal note (optional, not shown to the owner)" max={1000} value={approveNote} onChange={setApproveNote} />
                <Checkbox id="approve-indexable" label="Allow search engines to list this site" checked={indexable} onChange={setIndexable} />
                <button type="submit" className="btn-primary mt-4">
                  Approve and publish
                </button>
              </form>
              <form className="card" noValidate onSubmit={(e) => void reject(e)} aria-labelledby="reject-title">
                <h2 id="reject-title" className="text-lg font-semibold">
                  Reject
                </h2>
                <TextArea id="reject-note" label="Reason (the owner sees this)" hint="This is emailed to the owner." max={1000} value={rejectNote} onChange={setRejectNote} errors={rejectError} />
                <button type="submit" className="btn-secondary mt-4">
                  Reject and email the owner
                </button>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
