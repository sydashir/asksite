// Classic's About: the page opens like every inner page (the eyebrow, then "About {name}" as its <h1>), then the
// owner's story as a letter on a paper card: a drop cap (only when the story starts with a letter, so a leading
// quote mark or bracket is never set giant) and, at its foot, the owner's credentials (licenses, Insured, Free
// estimates, while the Credentials section renders, amendment A6). The founded year is a seal, Classic's stamp: on
// the owner's hero photo, framed beside the letter from 60rem (the eyebrow carries the year until then, as the photo
// sits under the letter there), or on the letter's corner without one, at every width. From 64rem a letter without a
// photo takes the page's width, its credentials in a column beside the story. Owner facts only; the name is said
// once, in the <h1>.
import { headingLevel, type RenderContext } from "../../context.ts";
import { html, safeUrl, trusted, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { ledger } from "./hero.ts";
import { pageHead, seal, sectionHead } from "./parts.ts";
import { bandClass, plan } from "./plan.ts";

/** A story that opens with a letter followed by a letter or a space gets the drop cap ("I'm" or "“We" do not). */
const DROP_CAP = /^\p{L}[\p{L}\s]/u;

export function renderAbout(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const title = `About ${facts.businessName}`;
  const hero = ctx.pages.find((p) => p.id === "home")?.sections.find((s) => s.id === "hero");
  const photo = hero?.variant === "photo" ? facts.heroPhoto : undefined;
  const proof = plan(ctx).trustShown && facts.licences.length + (facts.insured ? 1 : 0) + (facts.freeEstimates ? 1 : 0) > 0 && ledger(facts);
  const head =
    headingLevel(ctx, "about") === 1 ? pageHead(ctx, title, { id: `${DOM_ID.about}-title`, year: photo ? "tablets" : "none" }) : sectionHead(DOM_ID.about, title);
  const sealed = facts.yearFounded !== undefined;

  return html`<section id="${DOM_ID.about}" class="sec ${bandClass(ctx, "about")}" aria-labelledby="${DOM_ID.about}-title">
<div class="wr">
${head}
<div class="${photo ? "ab ab-ph" : "ab"}">
<div class="${["letter", !photo && sealed && "letter-sl", !photo && proof && "lt-w"].filter(Boolean).join(" ")}">
<svg class="rule" viewBox="0 0 112 12" aria-hidden="true">${trusted('<path d="M0 6h44m24 0h44" stroke="currentColor" stroke-width="1.5"/><path d="M56 1l5 5l-5 5l-5-5z" fill="currentColor"/>')}</svg>
<p class="${DROP_CAP.test((copy.about ?? "").trim()) ? "letter-b dc" : "letter-b"}">${copy.about}</p>
${proof}
${!photo && seal(facts)}
</div>
${photo && html`<div class="hm ab-m"><div class="frame"><img src="${safeUrl(photo.url, ["https:"])}" width="${photo.width}" height="${photo.height}" alt="${photo.alt}" decoding="async"></div>${seal(facts)}</div>`}
</div>
</div>
</section>`;
}
