// Classic's credentials: a ledger of owner facts only (license numbers as entered, "Insured", the founded
// year, 24/7 service, free estimates). Never "bonded" (California B&P Code 7071.13). Right after the hero it
// becomes a card over the hero's lower edge (from 60rem), leaving out what the hero already shows.
import type { RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon, lic, type ClassicIcon } from "./parts.ts";
import { plan } from "./plan.ts";

interface Item {
  icon: ClassicIcon;
  main: string;
  sub?: SafeHtml;
  /** The hero already shows it (the seal's year, the Call buttons' 24/7 note). */
  inHero?: boolean;
}

/** Column classes by item count (tg-N), so a row never ends with one item alone; two is the default. */
function columns(count: number): string {
  if (count === 1) return "tg tg-1";
  if (count === 3 || count === 6) return "tg tg-3";
  if (count === 5 || count === 9) return "tg tg-5";
  if (count === 4 || count === 7 || count === 8) return "tg tg-4";
  return "tg";
}

export function renderTrust(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const { lift, liftSwap, band } = plan(ctx);
  const items: Item[] = facts.licences.map((l) => ({ icon: "certificate", main: l.label, sub: html`License ${lic(l.number)}` }));
  if (facts.insured) items.push({ icon: "shield-check", main: "Insured" });
  if (facts.yearFounded !== undefined) items.push({ icon: "calendar", main: `In business since ${facts.yearFounded}`, inHero: true });
  if (facts.emergency247) items.push({ icon: "clock", main: "24/7 emergency service", inHero: true });
  if (facts.freeEstimates) items.push({ icon: "receipt", main: "Free estimates" });
  const shown = lift ? items.filter((item) => item.inHero !== true) : items;
  const odd = shown.length % 2 === 1;
  const row = (item: Item) =>
    html`${icon(item.icon)}<span><span class="tm">${item.main}</span>${item.sub !== undefined && html`<span class="tsub">${item.sub}</span>`}</span>`;
  const classes = ["trust", band.trust === "white" ? "bw" : "bp", lift && "tr-lift", liftSwap && "tr-swap", shown.length >= 6 && "tg-many"].filter(Boolean).join(" ");

  return html`<section id="${DOM_ID.trust}" class="${classes}" aria-label="Credentials">
<div class="wr">
<ul class="${columns(shown.length)}">
${shown.map((item, i) => (i === 0 && odd ? html`<li class="ti ti-w">${row(item)}</li>` : html`<li class="ti">${row(item)}</li>`))}
</ul>
</div>
</section>`;
}
