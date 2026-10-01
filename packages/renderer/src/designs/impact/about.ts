// The Bold about: the founding year as a large numeral (only when the owner gave one), then the AI's about
// text signed with the business name, then the owner's credentials (while the owner shows them on Home: a
// homeowner checking who they are about to let in looks here). It opens the About page, so its heading is the
// page's <h1> there and the numeral leads the content beside the text (A16).
import { headingLevel, onSite, type RenderContext } from "../../context.ts";
import { TRADE_LABEL } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { credentialSpecs } from "./credentials.ts";
import { addressMarkup, band } from "./parts.ts";
import { yearClass } from "./rules.ts";

export function renderAbout(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const year = facts.yearFounded;
  const numeral = year !== undefined && html`<p class="year"><span class="kicker">Since</span> <span class="${yearClass(year)}">${year}</span></p>`;
  const opens = headingLevel(ctx, "about") === 1;
  const specs = onSite(ctx, "trust") ? credentialSpecs(ctx, false) : [];

  return band(
    ctx,
    "about",
    { eyebrow: "About", title: "Who we are", pageTitle: `About ${facts.businessName}`, extra: !opens && numeral },
    year === undefined && opens ? "wrap about about--text" : "wrap about",
    html`${opens && numeral}<div class="about-body">
<p class="about-text">${copy.about}</p>
<p class="sign"><span class="sign-name">${addressMarkup(facts.businessName)}</span><span class="sign-meta">${TRADE_LABEL[facts.trade]} · ${facts.location.city}, ${facts.location.state}</span></p>
${specs.length > 0 && html`<dl class="specs about-specs">${specs}</dl>`}
</div>`,
  );
}
