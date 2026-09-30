import type { LayoutSection, Theme } from "@asksite/site-schema";
import type { RenderContext } from "./context.ts";
import type { SafeHtml } from "./html.ts";

/**
 * One page design (A12): what render() asks a design for. render() itself writes everything every
 * design shares (the head, JSON-LD, the skip link and <main>), so the shared invariants hold for all
 * of them (test/design-invariants.test.ts).
 */
export interface Design {
  /** The page's one HTML comment: the copyright notices of the code the design is built from. */
  readonly attribution: string;
  /** The classes on <body>. */
  readonly bodyClass: string;
  /** Extra custom properties for the page's :root rule, each named --aw-<design id>-*: design constants only, system fonts only. */
  variables(theme: Theme): Readonly<Record<string, string>>;
  header(ctx: RenderContext): SafeHtml;
  section(ctx: RenderContext, section: LayoutSection): SafeHtml;
  footer(ctx: RenderContext): SafeHtml;
  /** The phone call bar: the page's only <aside>. */
  callBar(ctx: RenderContext): SafeHtml;
}
