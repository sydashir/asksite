// The Bold reviews: the owner's first review as a large pull quote across the band, the others in ruled
// columns beneath, then the links to more reviews. No stars, counts, dates or "verified" marks.
import type { Facts, SocialLink } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, sectionHead } from "./parts.ts";

const REVIEW_SITES: Partial<Record<SocialLink["network"], string>> = { google: "Google", yelp: "Yelp" };

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
  const sites = socialLinks.flatMap((s) => {
    const site = REVIEW_SITES[s.network];
    return site === undefined ? [] : [{ url: safeUrl(s.url, ["https:"]), site }];
  });

  return html`<section id="${DOM_ID.testimonials}" class="${bandClass(ctx, "testimonials")}" aria-labelledby="${DOM_ID.testimonials}-title">
<div class="wrap rev-layout">
${sectionHead("testimonials", "Reviews", "What customers say")}
${lead && html`<figure class="rev-lead">${icon("quote", "q-mark")}<blockquote><p>${lead.quote}</p></blockquote>${byline(lead)}</figure>`}
${rest.length > 0 && html`<ul class="${gridClass(rest.length)}">${rest.map((t) => html`<li><figure><blockquote><p>${t.quote}</p></blockquote>${byline(t)}</figure></li>`)}</ul>`}
${sites.length > 0 && html`<ul class="rev-more">${sites.map((s) => html`<li><a href="${s.url}">Read more reviews on ${s.site}${icon("arrow-up-right")}</a></li>`)}</ul>`}
</div>
</section>`;
}
