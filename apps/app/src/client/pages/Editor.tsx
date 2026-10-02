import { composeDocument, type CurrentAi, type GenerationView, type Issue, type OwnerEdits, type SiteView } from "@asksite/core";
import { SECTION_PAGE, type SectionId, type SiteDocument } from "@asksite/site-schema";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import { linkAfter, navigate } from "../hooks/use-route.ts";
import { useSite, type Draft, type SiteState } from "../hooks/use-site.ts";
import { useStepProps } from "../hooks/use-step-props.ts";
import { useStylesheets } from "../hooks/use-stylesheets.ts";
import { api } from "../lib/api.ts";
import { stepOf } from "../lib/draft-issues.ts";
import { STEP_TITLE } from "../lib/labels.ts";
import { isThemeIssue, issuesAt, ownerMessage, type Fix } from "../lib/messages.ts";
import { checkDraft, renderPages } from "../lib/preview.ts";
import { pageWasReloaded } from "../lib/page-reload.ts";
import { reloadAfterSave } from "../lib/preview-sheets.ts";
import { paths, STEPS, type StepId } from "../lib/route.ts";
import { issueTarget, type Path } from "../lib/values.ts";
import { STEP_BODY } from "../steps/index.tsx";
import { PhotoManager } from "../steps/PhotosStep.tsx";

type EditorTab = "words" | "look" | "sections" | "photos" | "details";
const TABS: ReadonlyArray<{ id: EditorTab; label: string }> = [
  { id: "words", label: "Words" },
  { id: "look", label: "Look" },
  { id: "sections", label: "Sections" },
  { id: "photos", label: "Photos" },
  { id: "details", label: "Details" },
];

const AI_NOT_LOADED = "The new wording is ready, but we couldn't load it. Reload the page to see it.";
const NOT_SAVED = "Your latest changes are not saved yet. Please try again in a moment.";

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
  const [rewriteId, setRewriteId] = useState<string | null>(null);
  const [rewriteMessage, setRewriteMessage] = useState("");
  // Until the AI's wording is fresh, wording and order stay read-only: an edit built on the old wording is ignored by the server.
  const [aiState, setAiState] = useState<"fresh" | "refreshing" | "unloaded">("fresh");
  const copyLocked = aiState !== "fresh";
  const [leaveMessage, setLeaveMessage] = useState<string | null>(null);
  const [follow, setFollow] = useState<FollowPage | null>(null);
  const rewriteStatus = useRef<HTMLParagraphElement>(null);
  // Publish and Messages save first and stay here if that fails, so Publish never sends an older draft (decision 37).
  const leave = linkAfter(site.flush, () => setLeaveMessage(NOT_SAVED));
  const { generation } = useGeneration(siteId, rewriteId);
  const { props: stepProps } = useStepProps(siteId, site, view, draft, true, me.state === "ready" ? me.owner.email : null);

  // The issues, "Fix N issues" and the Sections tab depend only on the draft (checkDraft), never on the stylesheets.
  const checked = useMemo(() => checkDraft(ai, draft), [ai, draft]);
  const [lastDoc, setLastDoc] = useState<SiteDocument | null>(null);
  if (checked.ok && checked.doc !== lastDoc) setLastDoc(checked.doc);
  const doc = checked.ok ? checked.doc : lastDoc;
  const issues: Issue[] = checked.ok ? [] : checked.issues;

  // The preview keeps the last valid page while the draft is invalid; it renders at low priority, so typing stays quick.
  const [sheets, retrySheets] = useStylesheets();
  const previewDoc = useDeferredValue(doc);
  const pages = useMemo(
    () => (previewDoc === null || sheets.status !== "ready" ? null : renderPages(previewDoc, { id: siteId, slug: view.slug }, __ROOT_DOMAIN__, sheets.sheets)),
    [previewDoc, sheets, siteId, view.slug],
  );
  const afterReload = useMemo(pageWasReloaded, []);
  const reloadPage = () => void reloadAfterSave(site.flush, () => location.reload()).then((reloaded) => (reloaded ? undefined : setLeaveMessage(NOT_SAVED)));

  const composed = useMemo(() => composeDocument(draft.facts, ai, draft.edits), [draft, ai]);
  const setEdits = (edits: OwnerEdits) => site.update(() => ({ edits }));
  const setCopyEdits = (edits: OwnerEdits) => {
    if (!copyLocked) setEdits(edits);
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
      setRewriteId(null);
      setAiState("refreshing");
      // "Ready" is said only once the wording is really on screen.
      void refreshAi().then((refreshed) => {
        setAiState(refreshed ? "fresh" : "unloaded");
        setRewriteMessage(refreshed ? "New wording is ready." : AI_NOT_LOADED);
      });
    } else if (generation.status === "failed") {
      setRewriteId(null);
      setRewriteMessage("We could not write new wording this time. Your current wording is unchanged.");
    }
  }, [generation, rewriteId, refreshAi]);

  async function rewrite() {
    setConfirming(false);
    setRewriteMessage("Writing new wording…");
    // The dialog gives focus back to the button that opened it as it closes; the result is announced here, so focus goes to it.
    requestAnimationFrame(() => rewriteStatus.current?.focus());
    const res = await api<{ generation: GenerationView }>("POST", `/api/sites/${siteId}/generations`, {});
    if (res.ok) setRewriteId(res.data.generation.id);
    else setRewriteMessage(res.error.message);
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
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
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
      <SaveStatus state={site.saver} onRetry={() => void site.flush()} onReload={() => void site.reload()} />
      {leaveMessage !== null ? (
        <div role="alert">
          <Notice tone="error">{leaveMessage}</Notice>
        </div>
      ) : null}
      {aiView.usedFallback ? <Notice tone="info">We wrote simple starter wording for you. You can change any of it, or press “Write new wording” later.</Notice> : null}

      {/* A live region that is always there, so screen readers hear when the preview stops or starts updating. */}
      <div role="status">
        {issues.length > 0 ? (
          <Notice tone="warning">
            {issues.length === 1 ? "Fix 1 issue to update the preview." : `Fix ${issues.length} issues to update the preview.`}{" "}
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
        <section aria-label="Edit" className={pane === "edit" ? "min-w-0" : "hidden min-w-0 md:block"}>
          <Tabs label="What to edit" idPrefix="editor" tabs={TABS} selected={tab} onSelect={setTab} />
          <div role="tabpanel" id={`editor-panel-${tab}`} aria-labelledby={`editor-tab-${tab}`} tabIndex={0} className="pt-2">
            {tab === "words" ? (
              <>
                <CopyLocked state={aiState} />
                <WordsTab ai={ai} edits={draft.edits} composed={composed} facts={stepProps.facts} readOnly={copyLocked} setEdits={setCopyEdits} errors={errors} fixFor={fixFor} openFix={openFix} onSection={showSection} />
                <div className="mt-6">
                  <button type="button" className="btn-secondary" disabled={rewriteId !== null} aria-disabled={copyLocked} onClick={() => (copyLocked ? undefined : setConfirming(true))}>
                    Write new wording
                  </button>
                  <p className="mt-2 text-sm text-slate-600">
                    {view.limits.generationsLeftToday} left today, {view.limits.generationsLeftTotal} left in total.
                  </p>
                </div>
              </>
            ) : null}
            {tab === "look" ? <LookTab aiTheme={ai.draft.theme} edits={draft.edits} trade={stepProps.facts["trade"]} setEdits={setEdits} /> : null}
            {tab === "sections" ? (
              <>
                <CopyLocked state={aiState} />
                <SectionsTab ai={ai} composed={composed} edits={draft.edits} readOnly={copyLocked} setEdits={setCopyEdits} onSection={showSection} />
              </>
            ) : null}
            {tab === "photos" ? <PhotoManager {...stepProps} /> : null}
            {tab === "details" ? (
              <>
                <label htmlFor="details-step" className="mt-4 block font-medium">
                  Which answers?
                </label>
                <select id="details-step" className="mt-1 block w-full rounded-md border border-slate-500 bg-white px-3 py-2" value={detailsStep} onChange={(e) => setDetailsStep(e.target.value as StepId)}>
                  {STEPS.map((s) => (
                    <option key={s} value={s}>
                      {STEP_TITLE[s]}
                    </option>
                  ))}
                </select>
                <Details {...stepProps} />
              </>
            ) : null}
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
          <h2 id={PREVIEW_HEADING_ID} tabIndex={-1} className="mb-2 font-semibold">
            Preview
          </h2>
          <PreviewPane saved={site.saver.status === "saved"} sheets={sheets} pages={pages} follow={follow} afterReload={afterReload} onRetry={retrySheets} onReload={reloadPage} />
        </section>
      </div>

      <ConfirmDialog open={confirming} title="Write new wording?" confirmLabel="Write new wording" onConfirm={() => void rewrite()} onCancel={() => setConfirming(false)}>
        <p>This replaces all wording, including your edits. Your look, photos and hidden sections stay.</p>
      </ConfirmDialog>
    </div>
  );
}

/** Why wording and sections cannot be changed right now. */
function CopyLocked({ state }: { state: "fresh" | "refreshing" | "unloaded" }) {
  if (state === "fresh") return null;
  return <Notice tone="warning">{state === "refreshing" ? "Loading your new wording. Wording and sections can be changed again in a moment." : "Wording and sections can't be changed until the new wording is loaded."}</Notice>;
}
