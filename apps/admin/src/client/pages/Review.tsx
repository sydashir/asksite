import type { AdminVersionDetail } from "@asksite/core";
import { isSafeUrl, type PageId } from "@asksite/site-schema";
import { Fragment, useRef, useState, type FormEvent } from "react";
import { Checkbox, TextArea } from "../../../../app/src/client/components/fields.tsx";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { PagePreview } from "../../../../app/src/client/components/page-preview.tsx";
import { usePageHeading } from "../../../../app/src/client/hooks/use-page-heading.ts";
import { onLinkClick } from "../../../../app/src/client/hooks/use-route.ts";
import { api } from "../../../../app/src/client/lib/api.ts";
import { APPROVE_LEASE_LOST, APPROVE_LIVE_COPY_FAILED, COPIED_AGAIN, COPY_LIVE_COPY_FAILED } from "../../messages.ts";
import { useResource, useVerifiedPages } from "../hooks.ts";
import { flatten, textChanges } from "../lib/diff.ts";
import { FLAG_REASON, when } from "../lib/format.ts";

/** What the result region shows. `copyAgain`: the notice says the pages are not (all) live although the version is approved, so it offers "Copy the live pages again" (A16-4c). */
type Result = { tone: "success" | "error"; text: string; href?: string; copyAgain?: boolean };

/** Said once, politely, when Approve turns on. */
const UNLOCKED = "Every page has been looked at. You can approve now.";

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

/** An email or web address with line-break chances after "@" and "." (the text is unchanged), so it wraps between its parts. */
function Breakable({ text }: { text: string }) {
  return text.split(/(?<=[@.])/).map((part, i) => (
    <Fragment key={i}>
      {i > 0 ? <wbr /> : null}
      {part}
    </Fragment>
  ));
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
          <img src={photo.url} alt={photo.alt} className="h-16 w-20 rounded-lg border border-slate-200 object-cover" />
        </li>
      ))}
    </ul>
  );
}

export function Review({ versionId }: { versionId: string }) {
  const { load, reload } = useResource<AdminVersionDetail>(`/api/admin/versions/${versionId}`);
  if (load.state === "loading")
    return (
      <p role="status" className="flex items-center gap-2 text-slate-600">
        <span className="spinner" aria-hidden="true" />
        Loading…
      </p>
    );
  if (load.state === "error") return <Notice tone="error">{load.error.message}</Notice>;
  return <ReviewScreen detail={load.data} onDone={() => void reload()} />;
}

function ReviewScreen({ detail, onDone }: { detail: AdminVersionDetail; onDone: () => void }) {
  const { version, site, checks } = detail;
  const title = `Review ${site.businessName ?? site.slug ?? "site"} (version ${version.number})`;
  const heading = usePageHeading<HTMLHeadingElement>(title, "Admin");
  const [approveNote, setApproveNote] = useState("");
  const [indexable, setIndexable] = useState(true);
  const [rejectNote, setRejectNote] = useState("");
  const [rejectError, setRejectError] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const { verified, retry } = useVerifiedPages(detail.pages);
  /**
   * The pages whose frame has loaded at least once. It is a process aid, not a security check: the server approves only the exact stored
   * bytes whatever this client says (Approve sends the version's sha256, and Plan 2 proves every page's bytes). A frame that loaded does not
   * prove anyone read the page. It survives a reload after a failed Approve, so the retry stays available.
   */
  const [seen, setSeen] = useState<ReadonlySet<PageId>>(new Set());
  const onShown = (page: PageId) => setSeen((prev) => (prev.has(page) ? prev : new Set(prev).add(page)));
  const notSeen = detail.pages.filter((p) => !seen.has(p.page));
  // `length > 0` matters: [].every(...) is true, and a version with no stored pages cannot be approved.
  const canApprove = verified.state === "ready" && detail.pages.length > 0 && notSeen.length === 0;
  const gateId = detail.pages.length === 0 ? "no-pages-note" : "approve-gate";
  const resultRef = useRef<HTMLDivElement>(null);
  const changes = detail.liveDocument === null ? [] : textChanges(detail.liveDocument, detail.document);
  const pending = version.status === "pending";
  /**
   * A server error on Approve can come after the approval was committed and before the page was copied live (the live copy is the
   * last step, and a retry is accepted). The reload then shows "approved", but the page may not be live: keep Approve until it works.
   */
  const [approveFailed, setApproveFailed] = useState(false);
  /** One Approve at a time: a second press while one runs is ignored. */
  const [approving, setApproving] = useState(false);
  const showApprove = pending || approveFailed;
  const email = (detail.document as { facts?: { email?: unknown } }).facts?.email;
  const publicEmail = typeof email === "string" ? email : "(none)";
  /** Approve and Reject remove their own forms: keep keyboard focus on the result. */
  const showResult = (value: Result) => {
    setResult(value);
    requestAnimationFrame(() => resultRef.current?.focus());
  };

  async function approve(event: FormEvent) {
    event.preventDefault();
    // Approve is aria-disabled (it keeps focus), so a press, or Enter in a field, still arrives here.
    if (!canApprove || approving) return;
    setApproving(true);
    const res = await api<{ liveUrl: string }>("POST", `/api/admin/versions/${version.id}/approve`, { htmlSha256: version.htmlSha256, note: approveNote.trim(), indexable });
    setApproving(false);
    // After a lost lease (409, no Retry-After) the approval may have been committed too: keep Approve so it can be pressed again.
    setApproveFailed(!res.ok && (res.status >= 500 || res.error.message === APPROVE_LEASE_LOST));
    if (res.ok) showResult({ tone: "success", text: "Approved. We'll email the owner. The site goes live within about a minute:", href: res.data.liveUrl });
    else showResult({ tone: "error", text: res.error.message, copyAgain: res.error.message === APPROVE_LIVE_COPY_FAILED });
    onDone();
  }

  /** The approved version's pages are copied to live again (the site's live version is this one once it was approved). */
  async function copyAgain() {
    const res = await api("POST", `/api/admin/sites/${site.id}/copy-pages`, {});
    showResult(res.ok ? { tone: "success", text: COPIED_AGAIN } : { tone: "error", text: res.error.message, copyAgain: res.error.message === COPY_LIVE_COPY_FAILED });
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
        <a href="/" onClick={onLinkClick} className="link back-link">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to the review queue
        </a>
      </p>
      <h1 ref={heading} tabIndex={-1} className="page-title mt-1">
        {title}
      </h1>
      <p className="mt-2 text-slate-600">
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
            {result.copyAgain === true ? (
              <button type="button" className="btn-secondary mt-3" onClick={() => void copyAgain()}>
                Copy the live pages again
              </button>
            ) : null}
          </Notice>
        ) : null}
      </div>

      <div className="mt-8 grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="card min-w-0">
          <h2 className="section-title mb-4">The exact pages that will go live</h2>
          {detail.pages.length === 0 ? (
            <div id="no-pages-note">
              <Notice tone="warning">This version has no stored pages (it was sent before sites had several pages), so it cannot be approved.</Notice>
            </div>
          ) : verified.state === "ready" ? (
            <PagePreview pages={verified.sources} frameTitle="Page under review" onShown={onShown} />
          ) : verified.state === "loading" ? (
            <p role="status" className="mt-3 flex items-center gap-2 text-slate-600">
              <span className="spinner" aria-hidden="true" />
              Loading the page…
            </p>
          ) : (
            <div role="alert">
              <Notice tone="error">
                {verified.state === "error" ? "The page couldn't load." : `The ${verified.label} page doesn't match what was sent for review, so this version can't be approved. Try again, or reject it.`}
              </Notice>
              <button type="button" className="btn-secondary mt-3" onClick={retry}>
                Try again
              </button>
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <section className="card" aria-labelledby="checks-title">
            <h2 id="checks-title" className="section-title">
              Checks
            </h2>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 text-[0.9375rem] [&>dd]:border-t [&>dd]:border-slate-100 [&>dd]:py-2 [&>dt]:border-t [&>dt]:border-slate-100 [&>dt]:py-2 [&>dt]:text-slate-600">
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
              <dd className="[overflow-wrap:anywhere]">
                <Breakable text={publicEmail} />
              </dd>
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
            <h3 className="mt-5 font-semibold text-ink">Text to look at</h3>
            {checks.textFlags.length === 0 ? (
              <p className="mt-1 text-slate-600">Nothing flagged.</p>
            ) : (
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                {checks.textFlags.map((flag, i) => (
                  <li key={`${flag.path}-${flag.reason}-${i}`}>
                    <span className="code-tag">{flag.path}</span> {FLAG_REASON[flag.reason]}: “{editedText(detail.document, flag.path)}”
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="edited-title">
            <h2 id="edited-title" className="section-title">
              Wording the owner changed
            </h2>
            {detail.ownerEditedPaths.length === 0 ? (
              <p className="mt-1 text-slate-600">None: all wording is from the AI draft.</p>
            ) : (
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                {detail.ownerEditedPaths.map((path) => (
                  <li key={path}>
                    <span className="code-tag">{path}</span>: “{editedText(detail.document, path)}”
                  </li>
                ))}
              </ul>
            )}
          </section>

          {detail.liveDocument !== null ? (
            <section className="card" aria-labelledby="changes-title">
              <h2 id="changes-title" className="section-title">
                Changes since the live version
              </h2>
              {changes.length === 0 ? (
                <p className="mt-1 text-slate-600">No changes.</p>
              ) : (
                <ul className="mt-2 divide-y divide-slate-100">
                  {changes.map((change) => (
                    <li key={change.path} className="py-2.5">
                      <span className="code-tag">{change.path}</span>
                      <span className="block">Before: {change.before ?? "(none)"}</span>
                      <span className="block">After: {change.after ?? "(none)"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {showApprove ? (
            <>
              <form className="card border-t-4 border-t-brand-500" noValidate onSubmit={(e) => void approve(e)} aria-labelledby="approve-title">
                <h2 id="approve-title" className="section-title">
                  Approve
                </h2>
                <TextArea id="approve-note" label="Internal note (optional, not shown to the owner)" max={1000} value={approveNote} onChange={setApproveNote} />
                <Checkbox id="approve-indexable" label="Allow search engines to list this site" checked={indexable} onChange={setIndexable} />
                {canApprove || detail.pages.length === 0 ? null : (
                  <p id="approve-gate" className="mt-4 rounded-lg bg-slate-100 px-3 py-2.5 text-sm text-slate-800">
                    Look at every page before approving.{notSeen.length === 0 ? "" : ` Not looked at yet: ${notSeen.map((p) => p.label).join(", ")}.`}
                  </p>
                )}
                {/* aria-disabled, not disabled: Approve keeps keyboard focus, and its reason is read from the line above it. */}
                <button type="submit" className="btn-primary mt-5 w-full" aria-disabled={!canApprove || approving} aria-describedby={canApprove ? undefined : gateId}>
                  Approve and publish
                </button>
                <p role="status" className="sr-only">
                  {canApprove ? UNLOCKED : ""}
                </p>
              </form>
              {pending ? (
                <form className="card" noValidate onSubmit={(e) => void reject(e)} aria-labelledby="reject-title">
                  <h2 id="reject-title" className="section-title">
                    Reject
                  </h2>
                  <TextArea id="reject-note" label="Reason (the owner sees this)" hint="This is emailed to the owner." max={1000} value={rejectNote} onChange={setRejectNote} errors={rejectError} />
                  <button type="submit" className="btn-danger mt-5 w-full">
                    Reject and email the owner
                  </button>
                </form>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
