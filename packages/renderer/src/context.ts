import type { LayoutSection, SectionId, SiteDocument } from "@asksite/site-schema";
import type { SafeUrl } from "./html.ts";

/** Everything a section needs. Built once per render by render.ts. */
export interface RenderContext {
  readonly doc: SiteDocument;
  /** Sections that will actually render, in page order (layout minus sections with no content). */
  readonly sections: readonly LayoutSection[];
  readonly formAction: SafeUrl;
}

export function isVisible(ctx: RenderContext, id: SectionId): boolean {
  return ctx.sections.some((s) => s.id === id);
}
