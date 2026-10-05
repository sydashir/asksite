import { TAKEDOWN_REVIEW_NOTE, type Issue, type SiteView, type VersionSummary } from "@asksite/core";
import { isSafeUrl } from "@asksite/site-schema";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/dialog.tsx";
import { ErrorSummary, Notice, SaveStatus, type SummaryItem } from "../components/feedback.tsx";
import { ReviewPreview } from "../components/review-preview.tsx";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { onLinkClick, useLeaveGuard } from "../hooks/use-route.ts";
import { useSite, type SiteState } from "../hooks/use-site.ts";
import { api } from "../lib/api.ts";
import { stepOf } from "../lib/draft-issues.ts";
import { STEP_TITLE } from "../lib/labels.ts";
import { issuesToShow, ownerMessage } from "../lib/messages.ts";
import { paths } from "../lib/route.ts";
import { issueTarget } from "../lib/values.ts";

const NOT_SAVED = "Your latest changes are not saved yet. Please try again in a moment.";
const when = (ms: number) => new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** One line of the "things to fix" list. `facts` is the owner's newest local draft: opening-hours targets depend on how its entries are grouped. */
function summaryItem(siteId: string, issue: Issue, facts: unknown): SummaryItem {
  const message = ownerMessage(issue);
  const step = message.fix?.step ?? stepOf(issue);
  const id = issueTarget(message.fix?.field ?? issue.path, facts);
  if (step === null || step === undefined) return { id, text: message.text, href: paths.edit(siteId) };
  return { id, text: `${STEP_TITLE[step]}: ${message.text}`, href: `${paths.setup(siteId, step)}#${id}` };
}

/** Publish, waiting for approval, withdraw, live link, rejection note (§3.1 steps 6 to 8). */
export function Publish({ siteId }: { siteId: string }) {
  const site = useSite(siteId);
  if (site.load.state === "error") return <Notice tone="error">{site.load.message}</Notice>;
  if (site.load.state === "loading" || site.draft === null) return <p role="status">Loading…</p>;
  return <PublishScreen siteId={siteId} site={site} view={site.load.view} facts={site.draft.facts} />;
}

function PublishScreen({ siteId, site, view, facts }: { siteId: string; site: SiteState; view: SiteView; facts: unknown }) {
  const heading = usePageHeading<HTMLHeadingElement>("Publish your website");
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [problems, setProblems] = useState<Issue[]>([]);
  const [focusSignal, setFocusSignal] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  /** After an action the button that ran it may be gone: keep keyboard focus on the result. */
  const showResult = (text: string) => {
    setMessage(text);
    requestAnimationFrame(() => messageRef.current?.focus());
  };

  // Sign out and every link wait for the draft to be saved; a dropped wording change shows its notice (given focus), anything else says so below.
  useLeaveGuard(site.flush, (result) => (result === "dropped" ? requestAnimationFrame(() => noticeRef.current?.focus()) : showResult(NOT_SAVED)));

  const loadVersions = async () => {
    const res = await api<{ versions: VersionSummary[] }>("GET", `/api/sites/${siteId}/versions`);
    if (res.ok) setVersions(res.data.versions);
  };
  useEffect(() => {
    void loadVersions();
  }, [siteId]);

  async function publish() {
    setBusy(true);
    setMessage(null);
    setProblems([]);
    // Never send an older draft than the one on screen (decision 37).
    const saved = await site.flush();
    if (saved !== true) {
      setBusy(false);
      // A dropped wording change (carried from the editor) stops this once: its notice is shown above and given focus, and the next press goes on.
      if (saved === "dropped") requestAnimationFrame(() => noticeRef.current?.focus());
      else showResult(NOT_SAVED);
      return;
    }
    const res = await api<{ version: VersionSummary }>("POST", `/api/sites/${siteId}/publish-requests`, { rev: site.rev() });
    setBusy(false);
    if (res.ok) {
      await Promise.all([site.reload(), loadVersions()]);
      showResult("Sent for review. We will email you when it is live.");
      return;
    }
    if (res.error.code === "publish_invalid" && res.error.issues !== undefined) {
      setProblems(issuesToShow(res.error.issues));
      setFocusSignal((n) => n + 1);
      return;
    }
    setMessage(res.error.message);
  }

  async function withdraw() {
    setConfirmWithdraw(false);
    const res = await api("DELETE", `/api/sites/${siteId}/publish-requests/pending`);
    if (res.ok || res.status === 409) {
      await Promise.all([site.reload(), loadVersions()]);
      // 409 means nothing was pending any more (another tab withdrew it, or it was decided): never claim which, the status above says.
      showResult(res.ok ? "Your request was withdrawn. Nothing was published." : "There was no request waiting to withdraw. Its latest status is shown above.");
    } else showResult(res.error.message);
  }

  // A takedown also rejects the waiting version, with Plan 2's own note: that is not a request for a change (the takedown notice explains it).
  // It is still the newest review, so it ends the search: an older real rejection must not come back after a restore.
  const lastReviewed = versions.find((v) => v.status !== "pending" && v.status !== "superseded" && v.status !== "withdrawn");
  const rejected = !view.takenDown && !view.inReview && lastReviewed?.status === "rejected" && lastReviewed.reviewNote !== TAKEDOWN_REVIEW_NOTE ? lastReviewed : null;
  return (
    <section className="mx-auto max-w-2xl">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Publish your website
      </h1>
      <p className="mt-2">
        <a href={paths.edit(siteId)} onClick={onLinkClick} className="link">
          Back to editing
        </a>
      </p>
      <SaveStatus
        state={site.saver}
        onRetry={() => void site.retry()}
        onReload={() => void site.reload()}
        messageRef={noticeRef}
        onDismiss={() => {
          site.dismissDrop();
          noticeRef.current?.focus();
        }}
      />

      {view.takenDown ? (
        <Notice tone="error">
          Your website has been taken offline, so visitors cannot see it. We emailed you about it. If you have questions, write to{" "}
          <a className="link break-all" href={`mailto:${__SUPPORT_EMAIL__}`}>
            {__SUPPORT_EMAIL__}
          </a>
          .
        </Notice>
      ) : null}
      {view.live && view.liveUrl !== null && isSafeUrl(view.liveUrl, ["https:"]) ? (
        <Notice tone="success">
          Your website is live at{" "}
          <a href={view.liveUrl} className="link break-all">
            {view.liveUrl}
          </a>
          {view.draftDiffersFromLive ? <span className="block">You have changes that are not published yet.</span> : null}
        </Notice>
      ) : null}
      {rejected !== null ? (
        <Notice tone="warning">
          We asked for a change before your website goes live{rejected.reviewNote ? ":" : "."}
          {rejected.reviewNote ? <span className="mt-1 block whitespace-pre-line">{rejected.reviewNote}</span> : null}
        </Notice>
      ) : null}

      {view.pendingVersion !== null ? (
        <div className="card mt-6">
          <h2 className="text-lg font-semibold">Waiting for approval</h2>
          <p className="mt-2">
            Version {view.pendingVersion.number}, sent {when(view.pendingVersion.requestedAt)}. We check every website before it goes live, usually within one working day.
          </p>
          <ReviewPreview siteId={siteId} version={view.pendingVersion} />
          <button type="button" className="btn-secondary mt-4" onClick={() => setConfirmWithdraw(true)}>
            Withdraw this request
          </button>
          <p className="mt-3 text-sm text-slate-600">You can keep editing. Publishing again replaces this request.</p>
        </div>
      ) : null}

      <ErrorSummary items={problems.map((issue) => summaryItem(siteId, issue, facts))} focusSignal={focusSignal} />
      {view.takenDown ? null : (
        <div className="card mt-6">
          <h2 className="text-lg font-semibold">{view.pendingVersion !== null ? "Send your latest changes instead" : view.live ? "Publish your changes" : "Send your website for review"}</h2>
          <p className="mt-2">A person checks every website before it goes live. Your web address cannot change after this.</p>
          <button type="button" className="btn-primary mt-4" disabled={busy} onClick={() => void publish()}>
            {busy ? "Sending…" : "Send for review"}
          </button>
        </div>
      )}
      <div ref={messageRef} role="status" tabIndex={-1} className="mt-4">
        {message}
      </div>

      <ConfirmDialog open={confirmWithdraw} title="Withdraw your request?" confirmLabel="Withdraw" onConfirm={() => void withdraw()} onCancel={() => setConfirmWithdraw(false)}>
        <p>Nothing will be published. You can send it again at any time.</p>
      </ConfirmDialog>
    </section>
  );
}
