import type { SiteView } from "@asksite/core";
import { useCallback, useMemo } from "react";
import { answerIssues } from "../lib/draft-issues.ts";
import { issuesAt, ownerMessage } from "../lib/messages.ts";
import { setIn, asRecord, type Path } from "../lib/values.ts";
import type { StepProps } from "../steps/types.ts";
import type { Draft, SiteState } from "./use-site.ts";

/** Builds the props every step body receives, and the current answer issues. */
export function useStepProps(siteId: string, site: SiteState, view: SiteView, draft: Draft, showErrors: boolean, ownerEmail: string | null) {
  const { update } = site;
  const setFacts = useCallback((path: Path, value: unknown) => update((d) => ({ facts: setIn(d.facts, path, value) })), [update]);
  const setBrief = useCallback((path: Path, value: unknown) => update((d) => ({ brief: setIn(d.brief, path, value) })), [update]);
  const issues = useMemo(() => answerIssues(draft, view, site.saver.issues?.photos ?? view.issues.photos), [draft, view, site.saver.issues]);
  const errors = useCallback((path: Path) => (showErrors ? issuesAt(issues, path).map((i) => ownerMessage(i).text) : []), [issues, showErrors]);
  const props: StepProps = {
    siteId,
    view,
    site,
    facts: asRecord(draft.facts),
    brief: asRecord(draft.brief),
    setFacts,
    setBrief,
    errors,
    ownerEmail,
    thisYear: new Date().getFullYear(),
  };
  return { props, issues };
}
