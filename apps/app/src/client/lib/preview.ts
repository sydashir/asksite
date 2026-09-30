import { composeDocument, previewFormActionUrl, toIssues, type CurrentAi, type Issue, type OwnerEdits } from "@asksite/core";
import { render, type DesignStylesheets } from "@asksite/renderer";
import { SiteDocument, type DesignId } from "@asksite/site-schema";
import { issuesToShow } from "./messages.ts";

export interface DraftParts {
  facts: unknown;
  brief: unknown;
  edits: OwnerEdits;
}

export type Preview = { ok: true; doc: SiteDocument; html: string } | { ok: false; issues: Issue[] };

/**
 * The exact page the draft would publish, rendered in the browser with Plan 1's pure render()
 * (§3.1 step 5), from the design sheets loadStylesheets gave. The form action is previewFormActionUrl
 * (the site's own form address, or the reserved "preview" host before a web address is chosen); the
 * sandboxed preview can never submit it. The issues are the ones to show and count (issuesToShow), so
 * one empty closing time counts once.
 */
export function buildPreview(ai: CurrentAi, draft: DraftParts, site: { id: string; slug: string | null }, root: string, stylesheets: DesignStylesheets): Preview {
  const parsed = SiteDocument.safeParse(composeDocument(draft.facts, ai, draft.edits));
  if (!parsed.success) return { ok: false, issues: issuesToShow(toIssues(parsed.error)) };
  const { html } = render(parsed.data, { stylesheets, formAction: previewFormActionUrl(root, site.slug, site.id) });
  return { ok: true, doc: parsed.data, html };
}

/** The design the draft's page is drawn in: the owner's choice, else the AI draft's (as composeDocument picks the theme). */
export function previewDesign(ai: CurrentAi, edits: OwnerEdits): DesignId {
  return edits.theme?.design ?? ai.draft.theme.design;
}

export type ImportStylesheets = () => Promise<{ readonly DESIGN_CSS: DesignStylesheets }>;

/**
 * Loads every design's stylesheet on first use. The dynamic import keeps @asksite/site-css out of the
 * main bundle, in one lazy chunk (P4-20 amendment, option A). A successful import is kept, so the
 * importer runs at most once; a failed one is not, so asking again (the preview's "try again") calls
 * the importer again.
 */
export function stylesheetLoader(importSheets: ImportStylesheets = () => import("@asksite/site-css")): () => Promise<DesignStylesheets> {
  let loaded: Promise<DesignStylesheets> | null = null;
  return () => {
    loaded ??= importSheets().then(
      (sheets) => sheets.DESIGN_CSS,
      (error: unknown) => {
        loaded = null;
        throw error;
      },
    );
    return loaded;
  };
}

/** The app's one loader, shared by every preview. */
export const loadStylesheets = stylesheetLoader();
