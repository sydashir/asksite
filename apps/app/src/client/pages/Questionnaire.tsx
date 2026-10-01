import type { GenerationView, Issue, SiteView } from "@asksite/core";
import { useEffect, useState, type FormEvent } from "react";
import { TextArea } from "../components/fields.tsx";
import { ErrorSummary, Notice, SaveStatus, type SummaryItem } from "../components/feedback.tsx";
import { useMe } from "../hooks/use-me.ts";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { linkAfter, navigate } from "../hooks/use-route.ts";
import { useSite, type Draft, type SiteState } from "../hooks/use-site.ts";
import { useStepProps } from "../hooks/use-step-props.ts";
import { api } from "../lib/api.ts";
import { issuesForStep, stepOf } from "../lib/draft-issues.ts";
import { STEP_TITLE } from "../lib/labels.ts";
import { ownerMessage } from "../lib/messages.ts";
import { nextStep, paths, previousStep, STEPS, type StepId } from "../lib/route.ts";
import { asRecord, asString, fieldId, issueTarget } from "../lib/values.ts";
import { STEP_BODY } from "../steps/index.tsx";

export function Questionnaire({ siteId, step }: { siteId: string; step: StepId }) {
  const site = useSite(siteId);
  if (site.load.state === "loading" || site.draft === null) return <p role="status">Loading your answers…</p>;
  if (site.load.state === "error") return <Notice tone="error">{site.load.message}</Notice>;
  return <StepPage siteId={siteId} step={step} site={site} view={site.load.view} draft={site.draft} />;
}

function summaryItem(siteId: string, current: StepId, issue: Issue): SummaryItem {
  const step = stepOf(issue) ?? current;
  const text = ownerMessage(issue).text;
  const id = issueTarget(issue.path);
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
  const { props, issues } = useStepProps(siteId, site, view, draft, showErrors, me.state === "ready" ? me.owner.email : null);
  const Body = STEP_BODY[step];
  const last = nextStep(step) === null;
  const blocking = last ? issues : issuesForStep(issues, step);

  // Arriving from a "fix this" link (#field-id): show the errors and focus that field.
  useEffect(() => {
    const target = location.hash.slice(1);
    if (target !== "") requestAnimationFrame(() => document.getElementById(target)?.focus());
  }, []);

  async function build() {
    setBusy(true);
    setMessage(null);
    if (!(await site.flush())) {
      setBusy(false);
      setMessage("Your latest answers are not saved yet. Please try again in a moment.");
      return;
    }
    const res = await api<{ generation: GenerationView }>("POST", `/api/sites/${siteId}/generations`, {});
    setBusy(false);
    if (res.ok || res.error.code === "generation_in_progress") {
      navigate(paths.build(siteId));
      return;
    }
    const first = res.error.issues?.[0];
    if (res.error.code === "not_ready" && first !== undefined) {
      navigate(`${paths.setup(siteId, stepOf(first) ?? "business")}#${issueTarget(first.path)}`);
      return;
    }
    setMessage(res.error.message);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (blocking.length > 0) {
      setShowErrors(true);
      setFocusSignal((n) => n + 1);
      return;
    }
    const next = nextStep(step);
    if (next === null) void build();
    else
      void site.flush().then((saved) => {
        if (saved) navigate(paths.setup(siteId, next));
        else setMessage("Your latest answers are not saved yet. Please try again in a moment.");
      });
  }

  const comments = asRecord(asRecord(draft.brief)["comments"]);
  const previous = previousStep(step);
  // Links to other steps save first and stay here if that fails (decision 37).
  const leave = linkAfter(site.flush, () => setMessage("Your latest answers are not saved yet. Please try again in a moment."));
  return (
    <form noValidate onSubmit={onSubmit} className="mx-auto max-w-2xl">
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
      <ErrorSummary items={showErrors ? blocking.map((i) => summaryItem(siteId, step, i)) : []} focusSignal={focusSignal} />
      <div className="card mt-6">
        <Body {...props} />
        <TextArea
          id={fieldId(["brief", "comments", step])}
          label="Anything we should know about this?"
          optional
          max={500}
          value={asString(comments[step])}
          errors={props.errors(["brief", "comments", step])}
          onChange={(v) => props.setBrief(["comments", step], v === "" ? undefined : v)}
        />
      </div>
      {message !== null ? (
        <div role="alert">
          <Notice tone="error">{message}</Notice>
        </div>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <SaveStatus state={site.saver} onRetry={() => void site.flush()} onReload={() => void site.reload()} />
        <div className="flex flex-wrap gap-3">
          {previous !== null ? (
            <a className="btn-secondary" href={paths.setup(siteId, previous)} onClick={leave}>
              Back
            </a>
          ) : null}
          <button type="submit" className="btn-primary" disabled={busy}>
            {last ? (busy ? "Starting…" : "Build my website") : "Save and continue"}
          </button>
        </div>
      </div>
    </form>
  );
}
