// The Bold reviews: the owner's first review as a large pull quote across the band, up to four more in ruled
// columns beneath and any others behind "Read N more reviews" (a native <details>, no JavaScript), so a long list
// never takes over a phone's Home; then the links to more reviews. No stars, ratings, dates or "verified" marks.
import type { Facts, SocialLink } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, sectionHead } from "./parts.ts";

const REVIEW_SITES: Partial<Record<SocialLink["network"], string>> = { google: "Google", yelp: "Yelp" };

/** The reviews shown under the lead before "Read N more reviews". */
const SHOWN_REVIEWS = 4;

const byline = (t: Facts["testimonials"][number]) =>
  html`<figcaption class="rev-by"><span class="r-name">${t.name}</span>${t.location && html`<span class="r-loc">${t.location}</span>`}</figcaption>`;

/** The columns follow the number of further reviews, so rows come out full where they can. */
function gridClass(count: number): "rev-grid rev-grid--1" | "rev-grid rev-grid--2" | "rev-grid rev-grid--3" {
  if (count === 1) return "rev-grid rev-grid--1";
  return count % 3 !== 0 && count % 2 === 0 ? "rev-grid rev-grid--2" : "rev-grid rev-grid--3";
}

export function renderReviews(ctx: RenderContext): SafeHtml {
  const { testimonials, socialLinks } = ctx.doc.facts;
  const [lead, ...rest] = testimonials;
  const shown = rest.slice(0, SHOWN_REVIEWS);
  const more = rest.slice(SHOWN_REVIEWS);
  const grid = (list: typeof rest) => html`<ul class="${gridClass(list.length)}">${list.map((t) => html`<li><figure><blockquote><p>${t.quote}</p></blockquote>${byline(t)}</figure></li>`)}</ul>`;
  const sites = socialLinks.flatMap((s) => {
    const site = REVIEW_SITES[s.network];
    return site === undefined ? [] : [{ url: safeUrl(s.url, ["https:"]), site }];
  });

  return html`<section id="${DOM_ID.testimonials}" class="${bandClass(ctx, "testimonials")}" aria-labelledby="${DOM_ID.testimonials}-title">
<div class="wrap rev-layout">
${sectionHead(DOM_ID.testimonials, { eyebrow: "Reviews", title: "What customers say" })}
${lead && html`<figure class="rev-lead">${icon("quote", "q-mark")}<blockquote><p>${lead.quote}</p></blockquote>${byline(lead)}</figure>`}
${shown.length > 0 && grid(shown)}
${more.length > 0 && html`<details class="rev-rest"><summary>${icon("plus")}Read ${more.length} more ${more.length === 1 ? "review" : "reviews"}</summary>${grid(more)}</details>`}
${sites.length > 0 && html`<ul class="rev-more">${sites.map((s) => html`<li><a href="${s.url}">Read more reviews on ${s.site}${icon("arrow-up-right")}</a></li>`)}</ul>`}
</div>
</section>`;
}
