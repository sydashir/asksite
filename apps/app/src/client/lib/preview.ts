import { composeDocument, previewFormActionUrl, previewSiteUrl, toIssues, type CurrentAi, type Issue, type OwnerEdits } from "@asksite/core";
import { render, type DesignStylesheets, type RenderedSitePage } from "@asksite/renderer";
import { SiteDocument, type DesignId } from "@asksite/site-schema";
import { issuesToShow } from "./messages.ts";

export interface DraftParts {
  facts: unknown;
  brief: unknown;
  edits: OwnerEdits;
}

/** The draft as a valid document, or the issues to show and count (issuesToShow, so one empty closing time counts once). */
export type Checked = { ok: true; doc: SiteDocument } | { ok: false; issues: Issue[] };
export type Preview = { ok: true; doc: SiteDocument; pages: readonly RenderedSitePage[] } | { ok: false; issues: Issue[] };

/**
 * Whether the draft is a valid page document right now. Synchronous and free of the stylesheets, so the issues, the "Fix N
 * issues" count and the Sections tab never wait for them (and keep working when they fail to load). buildPreview calls this,
 * so the issues come from one source.
 */
export function checkDraft(ai: CurrentAi, draft: DraftParts): Checked {
  const parsed = SiteDocument.safeParse(composeDocument(draft.facts, ai, draft.edits));
  return parsed.success ? { ok: true, doc: parsed.data } : { ok: false, issues: issuesToShow(toIssues(parsed.error)) };
}

/** The pages of a valid document, from the design sheets loadStylesheets gave (Home first, one to five of them). */
export function renderPages(doc: SiteDocument, site: { id: string; slug: string | null }, root: string, stylesheets: DesignStylesheets): readonly RenderedSitePage[] {
  return render(doc, { stylesheets, formAction: previewFormActionUrl(root, site.slug, site.id), siteUrl: previewSiteUrl(root, site.slug) }).pages;
}

/**
 * The exact pages the draft would publish (Home first, one to five of them), rendered in the browser with Plan 1's
 * pure render() (§3.1 step 5), from the design sheets loadStylesheets gave. The form action is previewFormActionUrl
 * and the site address previewSiteUrl (the site's own, or the reserved "preview" host before a web address is chosen);
 * the sandboxed preview can never submit the form or follow a link.
 */
export function buildPreview(ai: CurrentAi, draft: DraftParts, site: { id: string; slug: string | null }, root: string, stylesheets: DesignStylesheets): Preview {
  const checked = checkDraft(ai, draft);
  return checked.ok ? { ok: true, doc: checked.doc, pages: renderPages(checked.doc, site, root, stylesheets) } : checked;
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
