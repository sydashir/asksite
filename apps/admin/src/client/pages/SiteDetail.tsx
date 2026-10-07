import type { AdminSiteRow, GenerationView, VersionSummary } from "@asksite/core";
import { siteUrl } from "@asksite/core";
import { isSafeUrl } from "@asksite/site-schema";
import { useEffect, useRef, useState } from "react";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { usePageHeading } from "../../../../app/src/client/hooks/use-page-heading.ts";
import { onLinkClick } from "../../../../app/src/client/hooks/use-route.ts";
import { api } from "../../../../app/src/client/lib/api.ts";
import { useResource } from "../hooks.ts";
import { COPIED_AGAIN, DELETE_LEASE_LOST, DELETE_UNFINISHED, TAKEDOWN_LEASE_LOST } from "../../messages.ts";
import type { OwnerDeletionView, TakedownView } from "../../settings-view.ts";
import { CapNote } from "../CapNote.tsx";
import { OwnerDeleteForm } from "../OwnerDeleteForm.tsx";
import { OwnerDisableForm } from "../OwnerDisableForm.tsx";
import { FinishForm, TakedownForm, type TakedownBody } from "../TakedownForms.tsx";
import { NOT_EMAILED, deletionResultText, jobLineText, restoredText, takedownResult, when, type TakedownResult } from "../lib/format.ts";

/** Finish the takedown from the down-site form is a re-run with no earlier result: its answer is the clean-up text, and no owner line is owed. */
const RE_RUN: TakedownResult = { tone: "success", text: "", cleanupFailed: false, ownerNotEmailed: false };
type Message = { tone: "success" | "warning" | "error"; text: string };

interface SiteDetailData {
  site: AdminSiteRow;
  /** When the takedown happened (null while the site is up): Restore sends it back, and a different takedown is refused (A16-4c). */
  takenDownAt: number | null;
  /** The newest moment the site came back up (null: never restored), read by the server: the up-site take-down form is keyed by it and sends it back. */
  restoredAt: number | null;
  versions: VersionSummary[];
  generations: Array<GenerationView & { provider: string | null; model: string | null; costMicrousd: number; modelSlot: 0 | 1; attempts: number }>;
  leadCount: number;
  /** How many sites the owner has (this one included): the delete dialog names it. */
  ownerSites: number;
  audit: Array<{ at: number; actor: string; action: string; detail: unknown }>;
}

export function SiteDetail({ siteId }: { siteId: string }) {
  const { load, reload } = useResource<SiteDetailData>(`/api/admin/sites/${siteId}`);
  if (load.state === "loading") return <p role="status">Loading…</p>;
  if (load.state === "error") return <Notice tone="error">{load.error.message}</Notice>;
  return <SiteScreen data={load.data} reload={reload} />;
}

function SiteScreen({ data, reload }: { data: SiteDetailData; reload: () => Promise<void> }) {
  const { site, takenDownAt, restoredAt } = data;
  const heading = usePageHeading<HTMLHeadingElement>(site.businessName ?? site.slug ?? "Site", "Admin");
  const [message, setMessage] = useState<Message | null>(null);
  /** A takedown answered 5xx, or lost its lease with a failed re-read: what to say depends on whether the reloaded site is down, so the text is chosen at render. */
  const [takedownUnsure, setTakedownUnsure] = useState(false);
  /** One takedown call at a time: a second press while one runs is ignored. */
  const [takingDown, setTakingDown] = useState(false);
  /** One act() call at a time (the search-engines toggle, Enable, Disable): a second press while one runs is ignored. A ref, so two presses in one tick cannot both pass. */
  const acting = useRef(false);
  const [busy, setBusy] = useState(false);
  /** One Delete the account call at a time, the same way. */
  const deletingNow = useRef(false);
  const [deleting, setDeleting] = useState(false);
  /** The body of a delete that did not finish (5xx, lost lease, offline): kept so "Finish deleting the account" sends the same one. */
  const [pendingDelete, setPendingDelete] = useState<{ confirmEmail: string } | null>(null);
  // The kept body belongs to the owner state it was sent for (§3.2: a form is opened for ONE state). Once the page shows the owner enabled, a later disable
  // is a new decision and starts over with the typed email and the dialog: a delete that never started must not come back as one press (review I-1).
  useEffect(() => {
    if (!site.ownerDisabled) setPendingDelete(null);
  }, [site.ownerDisabled]);
  /** The answer once the owner is gone: the page shows it instead of the site (which no longer exists, so nothing is reloaded). */
  const [deletion, setDeletion] = useState<OwnerDeletionView | null>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  /** The result of an action: shown in the status region, and keyboard focus moves to it (an action can replace the control that ran it: take down becomes restore). */
  const show = (value: Message) => {
    setMessage(value);
    setTakedownUnsure(false);
    requestAnimationFrame(() => messageRef.current?.focus());
  };

  async function act(method: "POST" | "PUT", path: string, body: unknown, done: string) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      const res = await api(method, path, body);
      show(res.ok ? { tone: "success", text: done } : { tone: "error", text: res.error.message });
      void reload();
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  /**
   * Sends Delete the account. Returns the field error when the server says the email differs. A 5xx, a lost lease or no connection (status 0) may come after
   * part of the deletion ran: nothing is reloaded, the body is kept, and the only control left is "Finish deleting the account".
   */
  async function deleteAccount(body: { confirmEmail: string }): Promise<string | null> {
    if (deletingNow.current) return null;
    deletingNow.current = true;
    setDeleting(true);
    try {
      const res = await api<OwnerDeletionView>("POST", `/api/admin/owners/${site.ownerId}/delete`, body);
      if (res.ok) {
        setDeletion(res.data);
        return null;
      }
      if (res.status === 0 || res.status >= 500 || res.error.message === DELETE_LEASE_LOST) {
        setPendingDelete(body);
        show({ tone: "error", text: DELETE_UNFINISHED });
        return null;
      }
      setPendingDelete(null);
      const mismatch = res.error.issues?.find((issue) => issue.path[0] === "confirmEmail");
      if (mismatch !== undefined) return mismatch.message;
      show({ tone: "error", text: res.error.message });
      void reload();
      return null;
    } finally {
      deletingNow.current = false;
      setDeleting(false);
    }
  }

  /** Sends the takedown moment this page showed: a restore refuses a site that was taken down again since (the answer says so). */
  async function restoreSite(expectedTakenDownAt: number) {
    const res = await api<{ liveUrl: string; missingPhotos: number }>("POST", `/api/admin/sites/${site.id}/restore`, { expectedTakenDownAt });
    // A lost lease: the reload below shows where the site stands (a live site always has "Copy the live pages again", a taken-down one has Restore).
    if (!res.ok) show({ tone: "error", text: res.error.message });
    else show({ tone: res.data.missingPhotos === 0 ? "success" : "warning", text: restoredText(res.data.missingPhotos) });
    void reload();
  }

  /** Copies the live version's pages to the live store again. It never changes whether the site is taken down. */
  async function copyAgain() {
    const res = await api("POST", `/api/admin/sites/${site.id}/copy-pages`, {});
    if (res.ok) show({ tone: "success", text: COPIED_AGAIN });
    else show({ tone: "error", text: res.error.message });
    void reload();
  }

  /** Takes the site down, or finishes a takedown that left its clean-up undone (the same call again; it never emails twice). */
  async function takeDown(body: TakedownBody, previous: TakedownResult | null, answered: () => void) {
    if (takingDown) return;
    setTakingDown(true);
    try {
      await runTakeDown(body, previous, answered);
    } finally {
      setTakingDown(false);
    }
  }

  async function runTakeDown(body: TakedownBody, previous: TakedownResult | null, answered: () => void) {
    const res = await api<TakedownView>("POST", `/api/admin/sites/${site.id}/takedown`, body);
    answered(); // the form resets on every answer, success or error
    if (!res.ok) {
      // A 500 can come after the takedown committed: say so rather than a plain error, and let the reload show the truth; if it shows the
      // site down, the Finish form is there. A lost lease whose re-read failed (noticeUnknown) is the same question: unknown whether this
      // call took the site down, so the text is chosen from the reloaded site, never the definite NOT_EMAILED.
      const leaseLost = res.error.message === TAKEDOWN_LEASE_LOST;
      if (res.status >= 500 || (leaseLost && res.error.noticeUnknown === true)) {
        // Wait for the reload, so the text below is chosen from the site's real state, not the one from before the takedown.
        await reload();
        setMessage(null);
        setTakedownUnsure(true);
        // The status region exists in both cases (site down or up): keep keyboard focus on the result, as show() does.
        requestAnimationFrame(() => messageRef.current?.focus());
        return;
      }
      // A lost lease (409, no Retry-After): the takedown may have committed. If the reload shows the site down, the Finish form finishes
      // its clean-up. The server already told the owner if this call took the site down and says how that went: noticeSent false means the
      // email failed, so the admin is told to contact the owner; Finish never emails.
      const text = leaseLost && res.error.noticeSent === false ? `${res.error.message} ${NOT_EMAILED}` : res.error.message;
      show({ tone: "error", text });
    } else {
      const result = takedownResult(res.data, previous);
      show({ tone: result.tone, text: result.text });
    }
    await reload();
  }

  async function sendSignInLink() {
    const res = await api("POST", `/api/admin/owners/${site.ownerId}/sign-in-link`, {});
    show(res.ok ? { tone: "success", text: `Sign-in link emailed to ${site.ownerEmail}.` } : { tone: "error", text: res.error.message });
  }

  if (deletion !== null) return <DeletedAccount view={deletion} />;

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
              ? "The takedown may have partly happened, and the owner may not have been emailed. Finish it to make sure, and contact the owner."
              : "The takedown did not go through. Try again."}
          </Notice>
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
              <FinishForm key={takenDownAt} takenDownAt={takenDownAt} busy={takingDown} onFinish={(body, answered) => takeDown(body, RE_RUN, answered)} />
            </>
          ) : (
            <TakedownForm key={`up-${restoredAt ?? "never"}`} restoredAt={restoredAt} busy={takingDown} onTakeDown={(body, answered) => takeDown(body, null, answered)} />
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
              aria-disabled={busy}
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
              <>
                <button type="button" className="btn-secondary" aria-disabled={busy} onClick={() => void act("POST", `/api/admin/owners/${site.ownerId}/enable`, {}, "Owner enabled.")}>
                  Enable the owner
                </button>
                <OwnerDeleteForm
                  key={`delete-${site.ownerId}`}
                  ownerEmail={site.ownerEmail}
                  siteCount={data.ownerSites}
                  busy={deleting}
                  unfinished={pendingDelete !== null}
                  onDelete={(confirmEmail) => deleteAccount({ confirmEmail })}
                  onFinish={async () => void (pendingDelete !== null && (await deleteAccount(pendingDelete)))}
                />
              </>
            ) : (
              <OwnerDisableForm key={`owner-${site.ownerDisabled ? "disabled" : "enabled"}`} busy={busy} onDisable={(reason) => act("POST", `/api/admin/owners/${site.ownerId}/disable`, { reason }, "Owner disabled and signed out everywhere.")} />
            )}
            {site.ownerDisabled ? null : <p className="mt-3 text-sm text-slate-700">To delete this owner's account, disable the owner first.</p>}
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
              <li key={g.id}>{jobLineText(g)}</li>
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
    </section>
  );
}

/** What the admin sees once the account is gone: the heading takes focus (the control that ran it is gone), and the way back is the list. */
function DeletedAccount({ view }: { view: OwnerDeletionView }) {
  const heading = usePageHeading<HTMLHeadingElement>("Account deleted", "Admin");
  return (
    <section>
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Account deleted
      </h1>
      <p className="mt-2" role="status">
        {deletionResultText(view)}
      </p>
      <p className="mt-4">
        <a href="/sites" onClick={onLinkClick} className="link">
          Back to sites
        </a>
      </p>
    </section>
  );
}
