// The Bold about (A16: it opens the About page, so its heading is the page's <h1>, the head band's "About <name>").
// The page shows who the visitor is about to let in: one of the owner's own photos beside the story when there is
// one, with the founding year on a tab over it. It prefers a photo neither Home's hero nor the Gallery's lead shows
// (while the gallery shows), so each page adds new proof; the hero photo only when it is the one photo. Without a
// photo the founding year as a large numeral leads, with the credentials under it; without either the story sits
// beside the credentials. The licence (while the owner shows the credentials) has a row of its own,
// so its number never squeezes. Owner facts and the AI's checked about text only.
import { onSite, type RenderContext } from "../../context.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { credentialSpecs } from "./credentials.ts";
import { band } from "./parts.ts";
import { yearClass } from "./rules.ts";

/** The about layout, by what the owner has: a photo, a founding year, credentials (each pins its grid areas in the sheet). */
type AboutLayout = "wrap about about--photo" | "wrap about about--photo about--wide" | "wrap about about--year" | "wrap about about--text" | "wrap about about--solo";

export function renderAbout(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const year = facts.yearFounded;
  // An owner photo the visitor has not seen yet: neither Home's hero nor the one that leads the Gallery page, when
  // the owner has one; else the Gallery's lead; the hero's only when it is the one photo shown on the site.
  const unseen = onSite(ctx, "gallery") ? facts.photos.filter((p) => p.url !== facts.heroPhoto?.url) : [];
  const photo = unseen.find((p) => p !== facts.photos[0]) ?? unseen[0] ?? facts.heroPhoto;
  const specs = onSite(ctx, "trust") ? credentialSpecs(ctx, { year: false, availability: true }) : [];
  const numeral = year !== undefined && html`<p class="year"><span class="kicker">Since</span> <span class="${yearClass(year)}">${year}</span></p>`;
  const media =
    photo !== undefined &&
    html`<figure class="about-media"><img src="${safeUrl(photo.url, ["https:"])}" width="${photo.width}" height="${photo.height}" alt="${photo.alt}" loading="eager" decoding="async">${numeral}</figure>`;
  const layout: AboutLayout =
    photo !== undefined
      ? facts.licences.length > 1 && specs.length > 0
        ? "wrap about about--photo about--wide"
        : "wrap about about--photo"
      : year !== undefined
        ? "wrap about about--year"
        : specs.length > 0
          ? "wrap about about--text"
          : "wrap about about--solo";

  return band(
    ctx,
    "about",
    { eyebrow: "About", title: "Who we are", pageTitle: `About ${facts.businessName}` },
    layout,
    html`${media || numeral}<div class="about-body"><p class="about-text">${copy.about}</p></div>
${specs.length > 0 && html`<dl class="${photo === undefined ? "specs about-specs specs--stack" : "specs about-specs"}">${specs}</dl>`}`,
  );
}
