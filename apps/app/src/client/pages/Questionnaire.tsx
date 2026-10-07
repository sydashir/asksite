import type { GenerationView, Issue, SiteView } from "@asksite/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { TextArea } from "../components/fields.tsx";
import { ErrorSummary, Notice, SaveStatus, type SummaryItem } from "../components/feedback.tsx";
import { useMe } from "../hooks/use-me.ts";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { linkAfter, navigate, useLeaveGuard } from "../hooks/use-route.ts";
import { useSite, type Draft, type SiteState } from "../hooks/use-site.ts";
import { useStepProps } from "../hooks/use-step-props.ts";
import { api } from "../lib/api.ts";
import { issuesForStep, stepOf } from "../lib/draft-issues.ts";
import { STEP_TITLE } from "../lib/labels.ts";
import { ownerMessage } from "../lib/messages.ts";
import { nextStep, paths, previousStep, STEPS, type StepId } from "../lib/route.ts";
import { asRecord, asString, fieldId, issueTarget } from "../lib/values.ts";
import { STEP_BODY } from "../steps/index.tsx";

/** Said when the answers are not saved (the Questionnaire holds answers, not "changes"). */
const ANSWERS_NOT_SAVED = "Your latest answers are not saved yet. Please try again in a moment.";

/** The id of the notice below; the Build button points at it with aria-describedby while it is shown. */
const AI_NOTICE_ID = "ai-provider-notice";
/** Said above the Build button: the answers may go to the AI provider (honesty; shown while the button builds, not at "Go to the editor"). */
const AI_PROVIDER_NOTICE = "To write your website, we may send your answers to our AI provider, Anthropic. They don't use them to train their AI.";

export function Questionnaire({ siteId, step }: { siteId: string; step: StepId }) {
  const site = useSite(siteId);
  if (site.load.state === "error") return <Notice tone="error">{site.load.message}</Notice>;
  if (site.load.state === "loading" || site.draft === null) return <p role="status">Loading your answers…</p>;
  return <StepPage siteId={siteId} step={step} site={site} view={site.load.view} draft={site.draft} />;
}

function summaryItem(siteId: string, current: StepId, issue: Issue, facts: unknown): SummaryItem {
  const step = stepOf(issue) ?? current;
  const text = ownerMessage(issue).text;
  const id = issueTarget(issue.path, facts);
  return step === current ? { id, text } : { id, text: `${STEP_TITLE[step]}: ${text}`, href: `${paths.setup(siteId, step)}#${id}` };
}

function StepPage({ siteId, step, site, view, draft }: { siteId: string; step: StepId; site: SiteState; view: SiteView; draft: Draft }) {
  const number = STEPS.indexOf(step) + 1;
  const heading = usePageHeading<HTMLHeadingElement>(`${STEP_TITLE[step]} (step ${number} of ${STEPS.length})`);
  const me = useMe();
  const [showErrors, setShowErrors] = useState(location.hash !== "");
  const [focusSignal, setFocusSignal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const { props, issues } = useStepProps(siteId, site, view, draft, showErrors, me.state === "ready" ? me.owner.email : null);
  const Body = STEP_BODY[step];
  const last = nextStep(step) === null;
  /** The AI-provider notice shows on the last step until the site has a draft; the Build button is described by it while it shows. */
  const aiNoticeShown = last && view.ai === null;
  const blocking = last ? issues : issuesForStep(issues, step);
  // A save that did not go through stops the action. A dropped wording change (carried from the editor) shows its own notice, given
  // focus; it never says "not saved yet" (the answers were saved), and the next attempt goes on.
  const stopped = (result: false | "dropped") => {
    if (result === "dropped") {
      setMessage(null);
      requestAnimationFrame(() => noticeRef.current?.focus());
    } else setMessage(ANSWERS_NOT_SAVED);
  };

  useLeaveGuard(site, stopped, ANSWERS_NOT_SAVED);

  // Arriving from a "fix this" link (#field-id): show the errors and focus that field.
  useEffect(() => {
    const target = location.hash.slice(1);
    if (target !== "") requestAnimationFrame(() => document.getElementById(target)?.focus());
  }, []);

  async function build() {
    setBusy(true);
    setMessage(null);
    const saved = await site.flush();
    if (saved !== true) {
      setBusy(false);
      stopped(saved);
      return;
    }
    // The FIRST build (handoff 2b): from a tab loaded before the first draft landed, the server answers generation_in_progress instead
    // of rewriting that draft, and the build page opens the editor.
    const res = await api<{ generation: GenerationView }>("POST", `/api/sites/${siteId}/generations`, { kind: "first" });
    setBusy(false);
    if (res.ok || res.error.code === "generation_in_progress") {
      navigate(paths.build(siteId));
      return;
    }
    const first = res.error.issues?.[0];
    if (res.error.code === "not_ready" && first !== undefined) {
      navigate(`${paths.setup(siteId, stepOf(first) ?? "business")}#${issueTarget(first.path, draft.facts)}`);
      return;
    }
    setMessage(res.error.message);
  }

  /** A draft already exists: save step 7 and open the editor. Never starts a generation (rewriting is the editor's own action). */
  async function openEditor() {
    const saved = await site.flush();
    if (saved === true) navigate(paths.edit(siteId));
    else stopped(saved);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    // Enter in a read-only field still submits: ignore it while a save runs.
    if (busy || site.locked) return;
    if (blocking.length > 0) {
      setShowErrors(true);
      setFocusSignal((n) => n + 1);
      return;
    }
    const next = nextStep(step);
    if (next === null) void (view.ai === null ? build() : openEditor());
    else
      void site.flush().then((saved) => {
        if (saved === true) navigate(paths.setup(siteId, next));
        else stopped(saved);
      });
  }

  const comments = asRecord(asRecord(draft.brief)["comments"]);
  const previous = previousStep(step);
  // Links to other steps save first and stay here if that fails (decision 37).
  const leave = linkAfter(site.flush, stopped);
  return (
    <form noValidate onSubmit={onSubmit} aria-busy={site.locked || undefined} className="mx-auto max-w-2xl">
      <p className="text-slate-700">
        Step {number} of {STEPS.length}
      </p>
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
        {STEP_TITLE[step]}
      </h1>
      <nav aria-label="Questionnaire steps" className="mt-3">
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {STEPS.map((s, i) => (
            <li key={s}>
              <a href={paths.setup(siteId, s)} onClick={leave} aria-current={s === step ? "step" : undefined} className={s === step ? "font-semibold text-slate-900" : "link"}>
                {i + 1}. {STEP_TITLE[s]}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <ErrorSummary items={showErrors ? blocking.map((i) => summaryItem(siteId, step, i, draft.facts)) : []} focusSignal={focusSignal} />
      <div className="card mt-6">
        {/* Read-only while a change that bypasses the autosaver runs (the web address): see useSite.exclusive. Not disabled: that drops keyboard focus. */}
        <div>
          <Body {...props} />
          <TextArea
            id={fieldId(["brief", "comments", step])}
            label="Anything we should know about this?"
            optional
            max={500}
            readOnly={site.locked}
            value={asString(comments[step])}
            errors={props.errors(["brief", "comments", step])}
            onChange={(v) => props.setBrief(["comments", step], v === "" ? undefined : v)}
          />
        </div>
      </div>
      {message !== null ? (
        <div role="alert">
          <Notice tone="error">{message}</Notice>
        </div>
      ) : null}
      {aiNoticeShown ? (
        <p id={AI_NOTICE_ID} className="mt-6 text-sm text-slate-700">
          {AI_PROVIDER_NOTICE}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
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
        <div className="flex flex-wrap gap-3">
          {previous !== null ? (
            <a className="btn-secondary" href={paths.setup(siteId, previous)} onClick={leave}>
              Back
            </a>
          ) : null}
          <button type="submit" className="btn-primary" aria-disabled={busy || site.locked} aria-describedby={aiNoticeShown ? AI_NOTICE_ID : undefined}>
            {last ? (view.ai !== null ? "Go to the editor" : busy ? "Starting…" : "Build my website") : "Save and continue"}
          </button>
        </div>
      </div>
    </form>
  );
}
