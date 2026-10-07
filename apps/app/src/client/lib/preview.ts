import { composeDocument, previewFormActionUrl, previewSiteUrl, toIssues, type CurrentAi, type Issue, type OwnerEdits } from "@asksite/core";
import type { DesignStylesheets, RenderedSite, RenderedSitePage, RenderOptions } from "@asksite/renderer";
import { SiteDocument } from "@asksite/site-schema";
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

/**
 * What the lazy chunk gives: Plan 1's pure `render` and the design sheets it needs. They load together, as one chunk, because
 * `render` holds every design's code (about 67 KB raw) and only the preview draws pages.
 */
export interface Renderer {
  readonly render: (doc: SiteDocument, options: RenderOptions) => RenderedSite;
  readonly sheets: DesignStylesheets;
}

/** The pages of a valid document, drawn by the renderer loadRenderer gave (Home first, one to five of them). */
export function renderPages(doc: SiteDocument, site: { id: string; slug: string | null }, root: string, renderer: Renderer): readonly RenderedSitePage[] {
  return renderer.render(doc, { stylesheets: renderer.sheets, formAction: previewFormActionUrl(root, site.slug, site.id), siteUrl: previewSiteUrl(root, site.slug) }).pages;
}

/**
 * The exact pages the draft would publish (Home first, one to five of them), rendered in the browser with Plan 1's
 * pure render() (§3.1 step 5), from the renderer loadRenderer gave. The form action is previewFormActionUrl
 * and the site address previewSiteUrl (the site's own, or the reserved "preview" host before a web address is chosen);
 * the sandboxed preview can never submit the form or follow a link.
 */
export function buildPreview(ai: CurrentAi, draft: DraftParts, site: { id: string; slug: string | null }, root: string, renderer: Renderer): Preview {
  const checked = checkDraft(ai, draft);
  return checked.ok ? { ok: true, doc: checked.doc, pages: renderPages(checked.doc, site, root, renderer) } : checked;
}

export type ImportRenderer = () => Promise<{ readonly RENDERER: Renderer }>;

/**
 * Loads `render` and every design's stylesheet on first use. The dynamic import keeps them (and @asksite/site-css) out of the
 * main bundle, in one lazy chunk (P4-20 amendment, option A; render joined it on 2026-10-06). A successful import is kept, so the
 * importer runs at most once; a failed one is not, so asking again (the preview's "try again") calls the importer again.
 */
export function rendererLoader(importRenderer: ImportRenderer = () => import("./render-chunk.ts")): () => Promise<Renderer> {
  let loaded: Promise<Renderer> | null = null;
  return () => {
    loaded ??= importRenderer().then(
      (chunk) => chunk.RENDERER,
      (error: unknown) => {
        loaded = null;
        throw error;
      },
    );
    return loaded;
  };
}

/** The app's one loader, shared by every preview. */
export const loadRenderer = rendererLoader();
