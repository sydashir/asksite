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
  /** The editor is frozen (new wording is being written): nothing may change, and nothing is uploaded or deleted. */
  frozen: boolean;
  thisYear: number;
}

/** Moves focus to an element once React has rendered it (after adding a list row, say). */
export function focusSoon(id: string): void {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

/**
 * Once React has rendered, focuses the first of these buttons that is still enabled. A Move button that has just reached the end
 * of its list is disabled, and a disabled button drops keyboard focus to the page, so the opposite Move button takes it.
 */
export function focusFirstEnabled(...ids: string[]): void {
  requestAnimationFrame(() => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el instanceof HTMLButtonElement && !el.disabled) {
        el.focus();
        return;
      }
    }
  });
}
