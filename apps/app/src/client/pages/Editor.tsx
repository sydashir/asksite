import { composeDocument, type CurrentAi, type GenerationView, type Issue, type OwnerEdits, type SiteView } from "@asksite/core";
import { SECTION_PAGE, type SectionId, type SiteDocument } from "@asksite/site-schema";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { ConfirmDialog } from "../components/dialog.tsx";
import { Notice, SaveStatus } from "../components/feedback.tsx";
import type { FollowPage } from "../components/page-preview.tsx";
import { Tabs } from "../components/tabs.tsx";
import { LookTab } from "../editor/LookTab.tsx";
import { PREVIEW_HEADING_ID, PreviewPane } from "../editor/PreviewPane.tsx";
import { SectionsTab } from "../editor/SectionsTab.tsx";
import { WordsTab } from "../editor/WordsTab.tsx";
import { useGeneration } from "../hooks/use-generation.ts";
import { useMe } from "../hooks/use-me.ts";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { linkAfter, navigate, useLeaveGuard } from "../hooks/use-route.ts";
import { useSite, type Draft, type SiteState } from "../hooks/use-site.ts";
import { useStepProps } from "../hooks/use-step-props.ts";
import { useStylesheets } from "../hooks/use-stylesheets.ts";
import { api } from "../lib/api.ts";
import { stepOf } from "../lib/draft-issues.ts";
import { STEP_TITLE } from "../lib/labels.ts";
import { AI_CLAIM, editorIssueNotice, isThemeIssue, issuesAt, ownerMessage, type Fix } from "../lib/messages.ts";
import { changedPage } from "../lib/changed-page.ts";
import { checkDraft, renderPages } from "../lib/preview.ts";
import { pageWasReloaded } from "../lib/page-reload.ts";
import { reloadAfterSave } from "../lib/preview-sheets.ts";
import { paths, STEPS, type StepId } from "../lib/route.ts";
import { issueTarget, type Path } from "../lib/values.ts";
import { STEP_BODY } from "../steps/index.tsx";
import { PhotoManager } from "../steps/PhotosStep.tsx";
import { NOT_SAVED } from "../lib/save-message.ts";

type EditorTab = "words" | "look" | "sections" | "photos" | "details";
const TABS: ReadonlyArray<{ id: EditorTab; label: string }> = [
  { id: "words", label: "Words" },
  { id: "look", label: "Look" },
  { id: "sections", label: "Sections" },
  { id: "photos", label: "Photos" },
  { id: "details", label: "Details" },
];

const NO_ISSUES: readonly Issue[] = [];
const AI_NOT_LOADED = "The new wording is ready, but we couldn't load it. Reload the page to see it.";
const REWRITING = "Writing new wording…";
/** Why the whole editor is locked from the request for new wording until it is shown. */
export const WRITING_LOCK = "Writing new wording. You can edit again when it is ready.";
/** Why the whole editor is locked when the new wording is ready but could not be loaded. */
const NOT_LOADED_LOCK = "The new wording is ready, but we couldn't load it. Reload the page to see it. You can edit again when it shows.";

export function Editor({ siteId }: { siteId: string }) {
  const site = useSite(siteId);
  const view = site.load.state === "ready" ? site.load.view : null;
  useEffect(() => {
    if (view === null || view.ai !== null) return;
    navigate(view.activeGeneration !== null ? paths.build(siteId) : paths.setup(siteId, "business"), { replace: true });
  }, [view, siteId]);
  if (site.load.state === "error") return <Notice tone="error">{site.load.message}</Notice>;
  if (view === null || view.ai === null || site.draft === null) return <p role="status">Loading your website…</p>;
  return <EditorScreen siteId={siteId} site={site} view={view} aiView={view.ai} draft={site.draft} />;
}

function EditorScreen(props: { siteId: string; site: SiteState; view: SiteView; aiView: NonNullable<SiteView["ai"]>; draft: Draft }) {
  const { siteId, site, view, aiView, draft } = props;
  const ai: CurrentAi = useMemo(() => ({ generationId: aiView.generationId, draft: aiView.draft }), [aiView]);
  const heading = usePageHeading<HTMLHeadingElement>("Edit your website");
  const me = useMe();
  const [tab, setTab] = useState<EditorTab>("words");
  const [detailsStep, setDetailsStep] = useState<StepId>("business");
  const [pane, setPane] = useState<"edit" | "preview">("edit");
  const [confirming, setConfirming] = useState(false);
  // A rewrite already running when the editor mounts (a reload, a return from Messages, another tab) is followed like one started here.
  const [rewriteId, setRewriteId] = useState<string | null>(() => (view.activeGeneration?.kind === "regenerate" ? view.activeGeneration.id : null));
  // From the request for new wording until its answer: the id is not known yet, but edits already must not be made.
  const [requesting, setRequesting] = useState(false);
  const [rewriteMessage, setRewriteMessage] = useState(rewriteId === null ? "" : REWRITING);
  // Until the AI's wording is fresh, wording and order stay read-only: an edit built on the old wording is ignored by the server.
  const [aiState, setAiState] = useState<"fresh" | "refreshing" | "unloaded">("fresh");
  // Generations this editor has seen end: a view that still names one of them (it is refreshed only on success) must not lock the editor again.
  const endedRewrites = useRef(new Set<string>());
  // The view names a rewrite this editor has not ended: the editor is locked by the VIEW itself, in the same render that shows it, so there is no
  // moment between a refused request (another tab's rewrite) and the effect that follows it in which the lock is off.
  const running = view.activeGeneration;
  const viewRunning = running !== null && running.kind === "regenerate" && !endedRewrites.current.has(running.id);
  const writing = requesting || rewriteId !== null || viewRunning;
  // FROZEN, from the request for new wording until it is shown (or it fails): every tab is read-only. A save that carried edits would be
  // refused by the server (answer and brief saves are stored), and one that carried the owner's wording would be replaced anyway. The same when the rewrite succeeded
  // but its wording could not be loaded ("unloaded"): nothing is editable until it is (Reload the page).
  const frozen = writing || aiState !== "fresh";
  const [leaveMessage, setLeaveMessage] = useState<string | null>(null);
  const [follow, setFollow] = useState<FollowPage | null>(null);
  const rewriteStatus = useRef<HTMLParagraphElement>(null);
  const saveMessage = useRef<HTMLParagraphElement>(null);
  // Publish and Messages save first and stay here if that fails, so Publish never sends an older draft (decision 37). A save that dropped
  // the owner's wording stops them once: the notice is shown and given focus (the next try goes on).
  const stopped = (result: false | "dropped") => {
    if (result === "dropped") {
      setLeaveMessage(null);
      requestAnimationFrame(() => saveMessage.current?.focus());
    } else setLeaveMessage(NOT_SAVED);
  };
  const leave = linkAfter(site.flush, stopped);
  // The header's link home leaves the editor too: the same save first, and the same stop for a dropped wording change. An ordinary failed
  // save does not stop it (decision 37: any other way of leaving still sends the unsaved changes), so "Your website" works in a conflict.
  useLeaveGuard(site, stopped);
  // A rewrite the view names (seen at mount, on a refetch, or after the server refused a save because another tab started one) is
  // followed like one started here: the whole editor locks until it lands or fails.
  useEffect(() => {
    if (running === null || running.kind !== "regenerate" || rewriteId !== null || requesting || endedRewrites.current.has(running.id)) return;
    setRewriteMessage(REWRITING);
    setRewriteId(running.id);
  }, [running, rewriteId, requesting]);
  const { generation } = useGeneration(siteId, rewriteId);
  const { props: stepProps } = useStepProps(siteId, site, view, draft, true, me.state === "ready" ? me.owner.email : null, frozen);

  // The preview's issues and the Sections tab depend only on the draft (checkDraft), never on the stylesheets.
  const checked = useMemo(() => checkDraft(ai, draft), [ai, draft]);
  const [lastDoc, setLastDoc] = useState<SiteDocument | null>(null);
  if (checked.ok && checked.doc !== lastDoc) setLastDoc(checked.doc);
  const doc = checked.ok ? checked.doc : lastDoc;
  // What stops the preview (checkDraft), then the server's AI-claim issues (handoff 1b: checked in the Worker only, with the answers
  // as they are now). Those do not stop the preview; they are shown at their fields and counted in the notice the same way.
  const blocking = checked.ok ? NO_ISSUES : checked.issues;
  const serverIssues = useNewestIssues(site.saver.issues, view.issues);
  const aiClaims = useMemo(() => serverIssues.document.filter((issue) => issue.code === AI_CLAIM), [serverIssues]);
  const issues = useMemo(() => [...blocking, ...aiClaims], [blocking, aiClaims]);
  const notice = editorIssueNotice(blocking.length, aiClaims.length);

  // The preview keeps the last valid page while the draft is invalid; it renders at low priority, so typing stays quick.
  const [sheets, retrySheets] = useStylesheets();
  const previewDoc = useDeferredValue(doc);
  const pages = useMemo(
    () => (previewDoc === null || sheets.status !== "ready" ? null : renderPages(previewDoc, { id: siteId, slug: view.slug }, __ROOT_DOMAIN__, sheets.renderer)),
    [previewDoc, sheets, siteId, view.slug],
  );
  // A change to an answer (Details, Photos) shows the page that draws it: the first page whose sections changed in the new preview (changedPage).
  // It waits for the preview to draw the change, and a change that no page section shows (only the shared footer) keeps the page on screen.
  const lastPages = useRef(pages);
  const handledChanges = useRef(site.factsChanges);
  const factsChanges = site.factsChanges;
  useEffect(() => {
    const before = lastPages.current;
    if (pages === before) return;
    lastPages.current = pages;
    if (factsChanges === handledChanges.current || before === null || pages === null || previewDoc === null) return;
    handledChanges.current = factsChanges;
    const page = changedPage(before, pages, previewDoc);
    if (page !== null) setFollow((last) => ({ page, n: (last?.n ?? 0) + 1 }));
  }, [pages, factsChanges, previewDoc]);
  const afterReload = useMemo(pageWasReloaded, []);
  const reloadPage = () => void reloadAfterSave(site.flush, () => location.reload()).then((reloaded) => (reloaded === true ? undefined : stopped(reloaded)));

  const composed = useMemo(() => composeDocument(draft.facts, ai, draft.edits), [draft, ai]);
  // The guard behind every read-only control: the controls say so (aria-disabled, focus kept), and nothing gets through here either.
  const setEdits = (edits: OwnerEdits) => {
    if (!frozen) site.update(() => ({ edits }));
  };
  const errors = (path: Path) => issuesAt(issues, path).map((i) => ownerMessage(i).text);
  const fixFor = (path: Path): Fix | undefined => issuesAt(issues, path).map((i) => ownerMessage(i).fix).find((f) => f !== undefined);
  const showSection = useCallback((id: SectionId) => setFollow((last) => ({ page: SECTION_PAGE[id], n: (last?.n ?? 0) + 1 })), []);
  const focusSoon = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());
  const openFix = (fix: Fix) => {
    setTab("details");
    setDetailsStep(fix.step);
    focusSoon(issueTarget(fix.field, draft.facts));
  };

  const { refreshAi } = site;
  useEffect(() => {
    if (rewriteId === null || generation?.id !== rewriteId) return;
    if (generation.status === "succeeded") {
      endedRewrites.current.add(rewriteId);
      setRewriteId(null);
      setAiState("refreshing");
      // "Ready" is said only once the wording is really on screen.
      void refreshAi().then((refreshed) => {
        setAiState(refreshed ? "fresh" : "unloaded");
        setRewriteMessage(refreshed ? "New wording is ready." : AI_NOT_LOADED);
      });
    } else if (generation.status === "failed") {
      // The stored edits were never touched while it ran (the editor was frozen and the server refuses saves that carry edits), so the lock just lifts.
      endedRewrites.current.add(rewriteId);
      setRewriteId(null);
      setRewriteMessage("We could not write new wording this time. Your current wording is unchanged.");
    }
  }, [generation, rewriteId, refreshAi]);

  async function rewrite() {
    setConfirming(false);
    setRewriteMessage(REWRITING);
    setRequesting(true);
    // The dialog gives focus back to the button that opened it as it closes; the result is announced here, so focus goes to it.
    requestAnimationFrame(() => rewriteStatus.current?.focus());
    // What is still unsaved goes first (the editor is frozen from here, so nothing new can be made). If it cannot be saved, or the owner has
    // not yet been told about a dropped change, the rewrite does not start: nothing is replaced behind an unsaved or unseen change.
    const flushed = await site.flush();
    if (flushed !== true) {
      setRequesting(false);
      setRewriteMessage("");
      stopped(flushed);
      return;
    }
    // A rewrite (handoff 2b): the server refuses it on a site with no draft, as it refuses the Questionnaire's "first" on one with a draft.
    const res = await api<{ generation: GenerationView }>("POST", `/api/sites/${siteId}/generations`, { kind: "regenerate" });
    if (res.ok) setRewriteId(res.data.generation.id);
    else {
      setRewriteMessage(res.error.message);
      // Another tab's rewrite is already running: this tab locks and follows it. The refreshed view names it (the effect above takes it from there).
      if (res.error.code === "generation_in_progress") await refreshAi();
    }
    setRequesting(false);
  }

  function goToIssue(issue: Issue) {
    // The newest local facts, never the loaded view's: opening-hours entries regroup as days change.
    const target = issueTarget(issue.path, draft.facts);
    if (issue.path[0] === "copy") setTab("words");
    else if (isThemeIssue(issue)) setTab("look");
    else {
      setTab("details");
      setDetailsStep(stepOf(issue) ?? "business");
    }
    setPane("edit");
    focusSoon(isThemeIssue(issue) ? "editor-panel-look" : target);
  }

  const Details = STEP_BODY[detailsStep];
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 ref={heading} tabIndex={-1} className="page-title">
          Edit your website
        </h1>
        <div className="flex flex-wrap gap-2">
          <a className="btn-secondary" href={paths.leads(siteId)} onClick={leave}>
            Messages
          </a>
          <a className="btn-primary" href={paths.publish(siteId)} onClick={leave}>
            Publish
          </a>
        </div>
      </div>
      <SaveStatus
        state={site.saver}
        onRetry={() => void site.retry()}
        onReload={() => void site.reload()}
        messageRef={saveMessage}
        onDismiss={() => {
          site.dismissDrop();
          saveMessage.current?.focus();
        }}
      />
      {leaveMessage !== null ? (
        <div role="alert">
          <Notice tone="error">{leaveMessage}</Notice>
        </div>
      ) : null}
      {frozen ? <Notice tone="warning">{aiState === "unloaded" && !writing ? NOT_LOADED_LOCK : WRITING_LOCK}</Notice> : null}
      {aiView.usedFallback ? <Notice tone="info">We wrote simple starter wording for you. You can change any of it, or press “Write new wording” later.</Notice> : null}

      {/* A live region that is always there, so screen readers hear when the preview stops or starts updating. */}
      <div role="status">
        {notice !== null ? (
          <Notice tone="warning">
            {notice}{" "}
            <button type="button" className="link" onClick={() => goToIssue(issues[0]!)}>
              Show me
            </button>
          </Notice>
        ) : null}
      </div>
      <div className="mt-4 flex gap-2 md:hidden" role="group" aria-label="Show">
        <button type="button" className="btn-secondary" aria-pressed={pane === "edit"} onClick={() => setPane("edit")}>
          Edit
        </button>
        <button type="button" className="btn-secondary" aria-pressed={pane === "preview"} onClick={() => setPane("preview")}>
          Preview
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <section aria-label="Edit" className={pane === "edit" ? "editor-panel min-w-0" : "editor-panel hidden min-w-0 md:block"}>
          <Tabs label="What to edit" idPrefix="editor" tabs={TABS} selected={tab} onSelect={setTab} />
          <div role="tabpanel" id={`editor-panel-${tab}`} aria-labelledby={`editor-tab-${tab}`} tabIndex={0} className="pt-2">
            <Frozen frozen={frozen}>
            {tab === "words" ? (
              <>
                <WordsTab ai={ai} edits={draft.edits} composed={composed} facts={stepProps.facts} readOnly={frozen} setEdits={setEdits} errors={errors} fixFor={fixFor} openFix={openFix} onSection={showSection} />
                <div className="mt-6">
                  <button type="button" className="btn-secondary" disabled={rewriteId !== null} aria-disabled={frozen} onClick={() => (frozen ? undefined : setConfirming(true))}>
                    Write new wording
                  </button>
                  <p className="mt-2 text-sm text-slate-600">
                    {view.limits.generationsLeftToday} left today, {view.limits.generationsLeftTotal} left in total.
                  </p>
                </div>
              </>
            ) : null}
            {tab === "look" ? <LookTab aiTheme={ai.draft.theme} edits={draft.edits} trade={stepProps.facts["trade"]} readOnly={frozen} setEdits={setEdits} /> : null}
            {tab === "sections" ? (
              <>
                <SectionsTab ai={ai} composed={composed} edits={draft.edits} readOnly={frozen} setEdits={setEdits} onSection={showSection} />
              </>
            ) : null}
            {tab === "photos" ? <PhotoManager {...stepProps} /> : null}
            {tab === "details" ? (
              <>
                <label htmlFor="details-step" className="mt-4 block font-medium">
                  Which answers?
                </label>
                <select id="details-step" className="field-input" value={detailsStep} onChange={(e) => setDetailsStep(e.target.value as StepId)}>
                  {STEPS.map((s) => (
                    <option key={s} value={s}>
                      {STEP_TITLE[s]}
                    </option>
                  ))}
                </select>
                <Details {...stepProps} />
              </>
            ) : null}
            </Frozen>
          </div>
          <p ref={rewriteStatus} role="status" tabIndex={-1} className="mt-3 text-slate-800">
            {rewriteMessage}
          </p>
          {aiState === "unloaded" ? (
            <button type="button" className="btn-secondary mt-2" onClick={reloadPage}>
              Reload the page
            </button>
          ) : null}
        </section>

        <section aria-label="Preview" className={pane === "preview" ? "min-w-0" : "hidden min-w-0 md:block"}>
          <h2 id={PREVIEW_HEADING_ID} tabIndex={-1} className="section-title mb-3">
            Preview
          </h2>
          <PreviewPane saved={site.saver.status === "saved" && site.saver.wordingDropped !== true} sheets={sheets} pages={pages} follow={follow} afterReload={afterReload} onRetry={retrySheets} onReload={reloadPage} />
        </section>
      </div>

      <ConfirmDialog open={confirming} title="Write new wording?" confirmLabel="Write new wording" onConfirm={() => void rewrite()} onCancel={() => setConfirming(false)}>
        <p>This replaces all wording, including your edits. Your look, photos and hidden sections stay.</p>
      </ConfirmDialog>
    </div>
  );
}

/**
 * The server's newest answer about the draft: the last save's (SiteState.saver.issues), or the view's when that is newer (the load,
 * or a view refreshed with new wording, whose AI-claim issues are about the new wording). A save on its way carries none, so the
 * last answer stays meanwhile instead of an older one coming back.
 */
function useNewestIssues(saved: SiteView["issues"] | undefined, viewed: SiteView["issues"]): SiteView["issues"] {
  const [seen, setSeen] = useState({ saved, viewed, newest: saved ?? viewed });
  if (saved === seen.saved && viewed === seen.viewed) return seen.newest;
  const newest = saved !== undefined && saved !== seen.saved ? saved : viewed !== seen.viewed ? viewed : seen.newest;
  setSeen({ saved, viewed, newest });
  return newest;
}

const typingKey = (event: KeyboardEvent<HTMLElement>): boolean => event.key === "Backspace" || event.key === "Delete" || (event.key.length === 1 && !event.ctrlKey && !event.metaKey);
const stopEvent = (event: SyntheticEvent): void => {
  event.preventDefault();
  event.stopPropagation();
};

/**
 * The editor while new wording is written: read-only on every tab. aria-disabled tells assistive technology; a click, a typed key, a paste,
 * a cut or a drop stops here before it reaches a control, and no control is ever disabled, so keyboard focus stays where it is.
 */
function Frozen({ frozen, children }: { frozen: boolean; children: ReactNode }) {
  return (
    <div
      role={frozen ? "group" : undefined}
      aria-disabled={frozen ? true : undefined}
      onClickCapture={frozen ? stopEvent : undefined}
      onKeyDownCapture={frozen ? (event) => (typingKey(event) ? stopEvent(event) : undefined) : undefined}
      onPasteCapture={frozen ? stopEvent : undefined}
      onCutCapture={frozen ? stopEvent : undefined}
      onDropCapture={frozen ? stopEvent : undefined}
    >
      {children}
    </div>
  );
}
