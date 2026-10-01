import type { SiteView } from "@asksite/core";
import type { SiteState } from "../hooks/use-site.ts";
import type { Json, Path } from "../lib/values.ts";

/** What every questionnaire step (and the editor's Details and Photos tabs) is given. */
export interface StepProps {
  siteId: string;
  view: SiteView;
  site: SiteState;
  facts: Json;
  brief: Json;
  /** Paths are relative to facts / brief, e.g. ["location", "city"]. */
  setFacts: (path: Path, value: unknown) => void;
  setBrief: (path: Path, value: unknown) => void;
  /** Owner-facing messages for the issue at this full path (e.g. ["facts", "phone"]), once errors are shown. */
  errors: (path: Path) => string[];
  ownerEmail: string | null;
  thisYear: number;
}

/** Moves focus to an element once React has rendered it (after adding a list row, say). */
export function focusSoon(id: string): void {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}
