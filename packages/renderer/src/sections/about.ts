// About: the owner's business name as the heading and the AI-written paragraph as text.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { html, type SafeHtml } from "../html.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

export function renderAbout(ctx: RenderContext, _variant: VariantOf<"about">): SafeHtml {
  const { facts, copy } = ctx.doc;
  return sectionShell(DOM_ID.about, "7xl", html`${headline(DOM_ID.about, `About ${facts.businessName}`)}
<p class="mx-auto max-w-3xl text-center text-lg text-pretty">${copy.about}</p>`);
}
