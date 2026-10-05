import type { AdminSiteRow, GenerationView, VersionSummary } from "@asksite/core";
import { siteUrl } from "@asksite/core";
import { isSafeUrl } from "@asksite/site-schema";
import { useRef, useState, type FormEvent } from "react";
import { ConfirmDialog } from "../../../../app/src/client/components/dialog.tsx";
import { Checkbox, TextArea, TextInput } from "../../../../app/src/client/components/fields.tsx";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { usePageHeading } from "../../../../app/src/client/hooks/use-page-heading.ts";
import { onLinkClick } from "../../../../app/src/client/hooks/use-route.ts";
import { api } from "../../../../app/src/client/lib/api.ts";
import { useResource } from "../hooks.ts";
import { COPIED_AGAIN, TAKEDOWN_LEASE_LOST } from "../../messages.ts";
import type { TakedownView } from "../../settings-view.ts";
import { CapNote } from "../CapNote.tsx";
import { dollars, restoredText, takedownResult, when, type TakedownResult } from "../lib/format.ts";

/** `expectedTakenDownAt` is sent only by Finish the takedown: the moment this page showed the site down (the server refuses a site restored since). */
type TakedownBody = { reason: string; ownerMessage?: string; purgeMedia: boolean; expectedTakenDownAt?: number };

/** The takedown reason's limit (core's TakedownBody): longer is refused here, in words, before anything is sent. It counts code points of the trimmed text, as zod's .max does. */
const REASON_MAX = 1000;
/** What is wrong with a takedown reason, or null. */
const reasonProblem = (value: string): string | null =>
  value.trim() === "" ? "Write the reason. It is kept in the audit log." : [...value.trim()].length > REASON_MAX ? `Please use ${REASON_MAX} characters or fewer.` : null;
/** Finish the takedown from the down-site form is a re-run with no earlier result: its answer is the clean-up text, and no owner line is owed. */
const RE_RUN: TakedownResult = { tone: "success", text: "", cleanupFailed: false, ownerNotEmailed: false };

type Message = { tone: "success" | "warning" | "error"; text: string };

interface SiteDetailData {
  site: AdminSiteRow;
  /** When the takedown happened (null while the site is up): Restore sends it back, and a different takedown is refused (A16-4c). */
  takenDownAt: number | null;
  versions: VersionSummary[];
  generations: Array<GenerationView & { provider: string | null; model: string | null; costMicrousd: number; attempts: number }>;
  leadCount: number;
  audit: Array<{ at: number; actor: string; action: string; detail: unknown }>;
}

export function SiteDetail({ siteId }: { siteId: string }) {
  const { load, reload } = useResource<SiteDetailData>(`/api/admin/sites/${siteId}`);
  if (load.state === "loading") return <p role="status">Loading…</p>;
  if (load.state === "error") return <Notice tone="error">{load.error.message}</Notice>;
  return <SiteScreen data={load.data} reload={() => reload()} />;
}

function SiteScreen({ data, reload }: { data: SiteDetailData; reload: () => Promise<void> }) {
  const { site, takenDownAt } = data;
  const heading = usePageHeading<HTMLHeadingElement>(site.businessName ?? site.slug ?? "Site", "Admin");
  const [message, setMessage] = useState<Message | null>(null);
  /** The last takedown and the body it sent: "Finish the takedown" re-sends exactly that body, and keeps its owner-notice line. */
  const [takedown, setTakedown] = useState<{ body: TakedownBody; result: TakedownResult } | null>(null);
  const [reason, setReason] = useState("");
  const [ownerMessage, setOwnerMessage] = useState("");
  const [purge, setPurge] = useState(false);
  const [reasonErrors, setReasonErrors] = useState<string[]>([]);
  const [confirmTakedown, setConfirmTakedown] = useState(false);
  /** The form on a down site that runs the takedown again: its own reason and photos choice, and no owner message (a re-run sends no notice). */
  const [finishReason, setFinishReason] = useState("");
  const [finishPurge, setFinishPurge] = useState(false);
  const [finishErrors, setFinishErrors] = useState<string[]>([]);
  const [disableReason, setDisableReason] = useState("");
  const [disableErrors, setDisableErrors] = useState<string[]>([]);
  /** A takedown answered 5xx: what to say depends on whether the reloaded site is down, so the text is chosen at render. */
  const [takedownUnsure, setTakedownUnsure] = useState(false);
  /** One takedown call at a time: a second press while one runs is ignored. */
  const [takingDown, setTakingDown] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);
  /** An action can replace the control that ran it (take down becomes restore): keep keyboard focus on the result. */
  const show = (value: Message) => {
    setMessage(value);
    setTakedownUnsure(false);
    requestAnimationFrame(() => messageRef.current?.focus());
  };

  async function act(method: "POST" | "PUT", path: string, body: unknown, done: string) {
    const res = await api(method, path, body);
    show(res.ok ? { tone: "success", text: done } : { tone: "error", text: res.error.message });
    reload();
  }

  /** Sends the takedown moment this page showed: a restore refuses a site that was taken down again since (the answer says so). */
  async function restoreSite(expectedTakenDownAt: number) {
    setTakedown(null);
    const res = await api<{ liveUrl: string; missingPhotos: number }>("POST", `/api/admin/sites/${site.id}/restore`, { expectedTakenDownAt });
    // A lost lease: the reload below shows where the site stands (a live site always has "Copy the live pages again", a taken-down one has Restore).
    if (!res.ok) show({ tone: "error", text: res.error.message });
    else show({ tone: res.data.missingPhotos === 0 ? "success" : "warning", text: restoredText(res.data.missingPhotos) });
    reload();
  }

  /** Copies the live version's pages to the live store again. It never changes whether the site is taken down. */
  async function copyAgain() {
    const res = await api("POST", `/api/admin/sites/${site.id}/copy-pages`, {});
    if (res.ok) show({ tone: "success", text: COPIED_AGAIN });
    else show({ tone: "error", text: res.error.message });
    reload();
  }

  /** Takes the site down, or finishes a takedown that left its clean-up undone (the same call again; it never emails twice). */
  async function takeDown(body: TakedownBody, previous: TakedownResult | null) {
    if (takingDown) return;
    setTakingDown(true);
    try {
      await runTakeDown(body, previous);
    } finally {
      setTakingDown(false);
    }
  }

  async function runTakeDown(body: TakedownBody, previous: TakedownResult | null) {
    const res = await api<TakedownView>("POST", `/api/admin/sites/${site.id}/takedown`, body);
    if (!res.ok) {
      // A 500 can come after the takedown committed: say so rather than a plain error, and let the reload show the truth. Keep the
      // body: if the reload shows the site down, "Finish the takedown" re-sends it. The owner notice is the route's last step and never
      // throws, so a call that answered 5xx sent none itself: keep the earlier result's owner-notice state, and with no earlier result
      // (this call may be the one that took the site down) mark the owner as not emailed.
      if (res.status >= 500) {
        setTakedown({ body, result: { tone: "warning", text: "", cleanupFailed: true, ownerNotEmailed: previous?.ownerNotEmailed ?? true } });
        // Wait for the reload, so the text below is chosen from the site's real state, not the one from before the takedown.
        await reload();
        setMessage(null);
        setTakedownUnsure(true);
        // The status region exists in both cases (site down or up): keep keyboard focus on the result, as show() does.
        requestAnimationFrame(() => messageRef.current?.focus());
        return;
      }
      show({ tone: "error", text: res.error.message });
      // A lost lease (409, no Retry-After): the takedown may have committed. If the reload shows the site down, Finish the takedown finishes
      // its clean-up. The server already told the owner if this call took the site down; Finish never emails.
      if (res.error.message === TAKEDOWN_LEASE_LOST) setTakedown({ body, result: { tone: "warning", text: "", cleanupFailed: true, ownerNotEmailed: false } });
    } else {
      const result = takedownResult(res.data, previous);
      setTakedown({ body, result });
      show({ tone: result.tone, text: result.text });
    }
    reload();
  }

  async function sendSignInLink() {
    const res = await api("POST", `/api/admin/owners/${site.ownerId}/sign-in-link`, {});
    show(res.ok ? { tone: "success", text: `Sign-in link emailed to ${site.ownerEmail}.` } : { tone: "error", text: res.error.message });
  }

  function askTakedown(event: FormEvent) {
    event.preventDefault();
    const problem = reasonProblem(reason);
    if (problem !== null) {
      setReasonErrors([problem]);
      document.getElementById("takedown-reason")?.focus();
      return;
    }
    setReasonErrors([]);
    setConfirmTakedown(true);
  }

  function submitFinish(event: FormEvent) {
    event.preventDefault();
    const problem = reasonProblem(finishReason);
    if (problem !== null) {
      setFinishErrors([problem]);
      document.getElementById("finish-reason")?.focus();
      return;
    }
    setFinishErrors([]);
    // No owner message: a re-run never emails. It names the takedown this page showed, so a site restored since is refused.
    void takeDown({ reason: finishReason.trim(), purgeMedia: finishPurge, ...(takenDownAt === null ? {} : { expectedTakenDownAt: takenDownAt }) }, RE_RUN);
  }

  /** Only ONE "Finish the takedown" shows at a time: the in-session one wins, because it carries the stored body and the owner-notice state. */
  const inSessionFinish = takedown?.result.cleanupFailed === true && site.takenDown;

  return (
    <section>
      <p>
        <a href="/sites" onClick={onLinkClick} className="link">
          Back to sites
        </a>
      </p>
      <h1 ref={heading} tabIndex={-1} className="mt-2 text-2xl font-bold">
        {site.businessName ?? site.slug ?? "Site"}
      </h1>
      <p className="mt-1 text-slate-700">
        {site.slug ?? "(no web address)"} · owner {site.ownerEmail}
        {site.ownerDisabled ? " (disabled)" : ""} · {site.takenDown ? "taken down" : site.live ? "live" : site.inReview ? "waiting for review" : "draft"} · search engines{" "}
        {site.indexable ? "allowed" : "blocked"} · {data.leadCount} messages
      </p>
      {site.live && site.slug !== null && isSafeUrl(siteUrl(__ROOT_DOMAIN__, site.slug), ["https:"]) ? (
        <p className="mt-1">
          <a className="link break-all" href={siteUrl(__ROOT_DOMAIN__, site.slug)}>
            {siteUrl(__ROOT_DOMAIN__, site.slug)}
          </a>
        </p>
      ) : null}
      <div ref={messageRef} role="status" tabIndex={-1}>
        {message !== null ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        {takedownUnsure ? (
          <Notice tone="error">
            {site.takenDown
              ? "The takedown may have partly happened, and the owner may not have been emailed. Finish it to make sure, and contact the owner:"
              : "The takedown did not go through. Try again."}
          </Notice>
        ) : null}
        {inSessionFinish ? (
          <button
            type="button"
            className="btn-primary mt-3"
            aria-disabled={takingDown}
            onClick={() => void takeDown({ ...takedown.body, ...(takenDownAt === null ? {} : { expectedTakenDownAt: takenDownAt }) }, takedown.result)}
          >
            Finish the takedown
          </button>
        ) : null}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card" aria-labelledby="actions-title">
          <h2 id="actions-title" className="text-lg font-semibold">
            Actions
          </h2>
          {takenDownAt !== null ? (
            <>
              <button type="button" className="btn-primary mt-3" onClick={() => void restoreSite(takenDownAt)}>
                Restore the site
              </button>
              {inSessionFinish ? null : (
                <form noValidate onSubmit={submitFinish} className="mt-4">
                  <TextInput id="finish-reason" label="Reason for finishing the takedown" max={REASON_MAX} value={finishReason} onChange={setFinishReason} errors={finishErrors} />
                  <Checkbox id="finish-purge" label="Also delete this site's photos" checked={finishPurge} onChange={setFinishPurge} />
                  <button type="submit" className="btn-secondary mt-3" aria-disabled={takingDown}>
                    Finish the takedown
                  </button>
                </form>
              )}
            </>
          ) : (
            <form noValidate onSubmit={askTakedown}>
              <TextInput id="takedown-reason" label="Reason for taking it down" max={REASON_MAX} value={reason} onChange={setReason} errors={reasonErrors} />
              <TextArea id="takedown-message" label="Message to the owner" optional max={1000} value={ownerMessage} onChange={setOwnerMessage} />
              <Checkbox id="takedown-purge" label="Also delete this site's photos" checked={purge} onChange={setPurge} />
              <button type="submit" className="btn-secondary mt-3">
                Take the site down
              </button>
            </form>
          )}
          {site.live ? (
            <div className="mt-4">
              <button type="button" className="btn-secondary" aria-describedby="copy-again-hint" onClick={() => void copyAgain()}>
                Copy the live pages again
              </button>
              <p id="copy-again-hint" className="mt-1 text-sm text-slate-700">
                Use this if the live site shows 'page not found' or older pages.
              </p>
            </div>
          ) : null}
          <div className="mt-4">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void act("PUT", `/api/admin/sites/${site.id}/indexable`, { indexable: !site.indexable }, site.indexable ? "Search engines are now blocked." : "Search engines are now allowed.")}
            >
              {site.indexable ? "Block search engines" : "Allow search engines"}
            </button>
          </div>
          <div className="mt-4 border-t border-slate-200 pt-3">
            {site.ownerDisabled ? null : (
              <button type="button" className="btn-secondary mb-3" onClick={() => void sendSignInLink()}>
                Send sign-in link
              </button>
            )}
            {site.ownerDisabled ? (
              <button type="button" className="btn-secondary" onClick={() => void act("POST", `/api/admin/owners/${site.ownerId}/enable`, {}, "Owner enabled.")}>
                Enable the owner
              </button>
            ) : (
              <form
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  if (disableReason.trim() === "") {
                    setDisableErrors(["Write the reason. It is kept in the audit log."]);
                    document.getElementById("disable-reason")?.focus();
                    return;
                  }
                  setDisableErrors([]);
                  void act("POST", `/api/admin/owners/${site.ownerId}/disable`, { reason: disableReason.trim() }, "Owner disabled and signed out everywhere.");
                }}
              >
                <TextInput id="disable-reason" label="Reason for disabling the owner" value={disableReason} onChange={setDisableReason} errors={disableErrors} />
                <button type="submit" className="btn-secondary mt-3">
                  Disable the owner
                </button>
              </form>
            )}
          </div>
        </section>

        <section className="card" aria-labelledby="versions-title">
          <h2 id="versions-title" className="text-lg font-semibold">
            Versions
          </h2>
          <ul className="mt-2 space-y-1">
            {data.versions.map((v) => (
              <li key={v.id}>
                Version {v.number}: {v.status}, sent {when(v.requestedAt)}
                {v.reviewNote ? ` (“${v.reviewNote}”)` : ""}
                {v.status === "pending" ? (
                  <>
                    {" "}
                    <a className="link" href={`/reviews/${v.id}`} onClick={onLinkClick}>
                      Review version {v.number}
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          <CapNote count={data.versions.length} cap={50} />
        </section>

        <section className="card" aria-labelledby="generations-title">
          <h2 id="generations-title" className="text-lg font-semibold">
            AI writing jobs
          </h2>
          <ul className="mt-2 space-y-1">
            {data.generations.map((g) => (
              <li key={g.id}>
                {when(g.createdAt)}: {g.kind}, {g.status}
                {g.usedFallback ? " (starter wording)" : ""} · {g.provider ?? "no model"} {g.model ?? ""} · {dollars(g.costMicrousd)} · {g.attempts} attempts
              </li>
            ))}
          </ul>
          <CapNote count={data.generations.length} cap={50} />
        </section>

        <section className="card" aria-labelledby="audit-title">
          <h2 id="audit-title" className="text-lg font-semibold">
            History
          </h2>
          <ul className="mt-2 space-y-1">
            {data.audit.map((a, i) => (
              <li key={`${a.at}-${i}`}>
                {when(a.at)}: {a.action} by {a.actor}
              </li>
            ))}
          </ul>
          <CapNote count={data.audit.length} cap={100} />
        </section>
      </div>

      <ConfirmDialog
        open={confirmTakedown}
        title="Take this site down?"
        confirmLabel="Take it down"
        onCancel={() => setConfirmTakedown(false)}
        onConfirm={() => {
          setConfirmTakedown(false);
          void takeDown({ reason: reason.trim(), ownerMessage: ownerMessage.trim(), purgeMedia: purge }, null);
        }}
      >
        <p>The page stops being served within about a minute{purge ? ", and its photos are deleted" : ""}.</p>
      </ConfirmDialog>
    </section>
  );
}
