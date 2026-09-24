// Trust strip (new; AstroWind has no credentials section). Every item is an owner fact:
// licence numbers exactly as entered, insured flag ("Insured", not "Fully insured": the owner
// only ticked a box), founding year and 24/7 flag. There is deliberately no "bonded" item:
// California B&P Code 7071.13 forbids referring to the contractor bond in advertising.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { html, type SafeHtml } from "../html.ts";
import { icon, type IconName } from "../icons.ts";
import { DOM_ID } from "./ids.ts";

const STYLE: Record<VariantOf<"trust">, { section: string; icon: string }> = {
  band: { section: "bg-dark text-white", icon: "h-6 w-6 shrink-0" },
  light: { section: "border-y border-gray-200 bg-page text-heading", icon: "h-6 w-6 shrink-0 text-primary" },
};

export function renderTrust(ctx: RenderContext, variant: VariantOf<"trust">): SafeHtml {
  const { facts } = ctx.doc;
  const items: Array<[IconName, string]> = facts.licences.map((l) => ["certificate", `${l.label}: ${l.number}`]);
  if (facts.insured) items.push(["shield-check", "Insured"]);
  if (facts.yearFounded !== undefined) items.push(["circle-check", `In business since ${facts.yearFounded}`]);
  if (facts.emergency247) items.push(["clock", "24/7 emergency service"]);
  const style = STYLE[variant];

  return html`<section id="${DOM_ID.trust}" aria-label="Credentials" class="${style.section}">
<div class="mx-auto max-w-7xl px-4 py-6 md:px-6">
<ul class="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 font-semibold">
${items.map(([name, text]) => html`<li class="flex min-w-0 items-center gap-2">${icon(name, style.icon)}<span class="min-w-0">${text}</span></li>`)}
</ul>
</div>
</section>`;
}
