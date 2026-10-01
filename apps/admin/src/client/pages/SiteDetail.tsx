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
import type { TakedownView } from "../../settings-view.ts";
import { CapNote } from "../CapNote.tsx";
import { dollars, restoredText, takedownResult, when, type TakedownResult } from "../lib/format.ts";

type TakedownBody = { reason: string; ownerMessage: string; purgeMedia: boolean };

interface SiteDetailData {
  site: AdminSiteRow;
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
  const { site } = data;
  const heading = usePageHeading<HTMLHeadingElement>(site.businessName ?? site.slug ?? "Site", "Admin");
  const [message, setMessage] = useState<{ tone: "success" | "warning" | "error"; text: string } | null>(null);
  /** The last takedown and the body it sent: "Finish the takedown" re-sends exactly that body, and keeps its owner-notice line. */
  const [takedown, setTakedown] = useState<{ body: TakedownBody; result: TakedownResult } | null>(null);
  const [reason, setReason] = useState("");
  const [ownerMessage, setOwnerMessage] = useState("");
  const [purge, setPurge] = useState(false);
  const [reasonErrors, setReasonErrors] = useState<string[]>([]);
  const [confirmTakedown, setConfirmTakedown] = useState(false);
  const [disableReason, setDisableReason] = useState("");
  const [disableErrors, setDisableErrors] = useState<string[]>([]);
  /** A takedown answered 5xx: what to say depends on whether the reloaded site is down, so the text is chosen at render. */
  const [takedownUnsure, setTakedownUnsure] = useState(false);
  const messageRef = useRef<HTMLDivElement>(null);
  /** An action can replace the control that ran it (take down becomes restore): keep keyboard focus on the result. */
  const show = (value: { tone: "success" | "warning" | "error"; text: string }) => {
    setMessage(value);
    setTakedownUnsure(false);
    requestAnimationFrame(() => messageRef.current?.focus());
  };

  async function act(method: "POST" | "PUT", path: string, body: unknown, done: string) {
    const res = await api(method, path, body);
    show(res.ok ? { tone: "success", text: done } : { tone: "error", text: res.error.message });
    reload();
  }

  async function restoreSite() {
    setTakedown(null);
    const res = await api<{ liveUrl: string; missingPhotos: number }>("POST", `/api/admin/sites/${site.id}/restore`, {});
    if (!res.ok) show({ tone: "error", text: res.error.message });
    else show({ tone: res.data.missingPhotos === 0 ? "success" : "warning", text: restoredText(res.data.missingPhotos) });
    reload();
  }

  /** Takes the site down, or finishes a takedown that left its clean-up undone (the same call again; it never emails twice). */
  async function takeDown(body: TakedownBody, previous: TakedownResult | null) {
    const res = await api<TakedownView>("POST", `/api/admin/sites/${site.id}/takedown`, body);
    if (!res.ok) {
      // A 500 can come after the takedown committed: say so rather than a plain error, and let the reload show the truth. Keep the
      // body: if the reload shows the site down, "Finish the takedown" re-sends it. That call never emails the owner (its own answer is
      // always null) and the failed one sent no notice, so the owner is marked as not emailed.
      if (res.status >= 500) setTakedown({ body, result: { tone: "warning", text: "", cleanupFailed: true, ownerNotEmailed: true } });
      if (res.status >= 500) {
        // Wait for the reload, so the text below is chosen from the site's real state, not the one from before the takedown.
        await reload();
        setMessage(null);
        setTakedownUnsure(true);
        return;
      }
      show({ tone: "error", text: res.error.message });
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
    if (reason.trim() === "") {
      setReasonErrors(["Write the reason. It is kept in the audit log."]);
      document.getElementById("takedown-reason")?.focus();
      return;
    }
    setReasonErrors([]);
    setConfirmTakedown(true);
  }

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
        {takedown?.result.cleanupFailed === true && site.takenDown ? (
          <button type="button" className="btn-primary mt-3" onClick={() => void takeDown(takedown.body, takedown.result)}>
            Finish the takedown
          </button>
        ) : null}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card" aria-labelledby="actions-title">
          <h2 id="actions-title" className="text-lg font-semibold">
            Actions
          </h2>
          {site.takenDown ? (
            <button type="button" className="btn-primary mt-3" onClick={() => void restoreSite()}>
              Restore the site
            </button>
          ) : (
            <form noValidate onSubmit={askTakedown}>
              <TextInput id="takedown-reason" label="Reason for taking it down" value={reason} onChange={setReason} errors={reasonErrors} />
              <TextArea id="takedown-message" label="Message to the owner" optional max={1000} value={ownerMessage} onChange={setOwnerMessage} />
              <Checkbox id="takedown-purge" label="Also delete this site's photos" checked={purge} onChange={setPurge} />
              <button type="submit" className="btn-secondary mt-3">
                Take the site down
              </button>
            </form>
          )}
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
