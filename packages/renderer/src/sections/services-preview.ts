// The services preview on Home (A16): the first three services, in the owner's order, and one link to the
// Services page. A render.ts block, not a layout section: it has no layout entry, no hide switch and no AI text.
import { type RenderContext, pageLink } from "../context.ts";
import { html, type SafeHtml } from "../html.ts";
import { headline, sectionShell } from "../ui.ts";
import { SERVICES_PREVIEW_ID } from "./ids.ts";
import { cardGrid, startingPrice } from "./services.ts";

const PREVIEW_COUNT = 3;

export function renderServicesPreview(ctx: RenderContext): SafeHtml {
  const items = ctx.doc.facts.services.slice(0, PREVIEW_COUNT);
  return sectionShell(SERVICES_PREVIEW_ID, "7xl", html`${headline(SERVICES_PREVIEW_ID, "Our services")}
<ul class="${cardGrid(items.length)}">
${items.map((s) => html`<li class="flex flex-col rounded-lg border border-gray-200 bg-white p-6 shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
<h3 class="text-xl font-bold text-heading">${s.name}</h3>
${startingPrice(s.startingPrice)}
</li>`)}
</ul>
<p class="mt-8 text-center"><a class="btn-secondary" href="${pageLink(ctx, "services")}">More about our services</a></p>`);
}
