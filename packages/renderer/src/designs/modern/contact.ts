// Modern's service area, questions and contact sections.
import { QUOTE_ID, type Facts, type VariantOf } from "@asksite/site-schema";
import { contactHeading } from "../../contact-heading.ts";
import { headingLevel, onSite, type RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl } from "../../format.ts";
import { html, trusted, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { itemHeading } from "../../ui.ts";
import { BUILDING } from "./icons.ts";
import { callButton, credentialList, emailText, emergencyNote, head, hoursTable, keepParts, pageBand, quoteButton } from "./parts.ts";
import { areaSummary, cityLine, fewPlaces } from "./text.ts";

/**
 * The street address with the building icon, or "Based in …": always at the foot of the places board, so a short list
 * beside the hours never leaves a hollow board (judges, A16 round 2); in the one-line band of one or two places only
 * when they do not already name the home town.
 */
function address(facts: Facts, always: boolean): SafeHtml | false {
  const { location, serviceArea } = facts;
  if (location.streetAddress !== undefined) return html`<div class="addr">${BUILDING}<address>${location.streetAddress}<br>${cityLine(facts)}</address></div>`;
  const home = location.city.trim().toLowerCase();
  return (always || !serviceArea.places.some((place) => place.trim().toLowerCase() === home)) && html`<p class="addr">${BUILDING}<span>Based in ${cityLine(facts)}</span></p>`;
}

/** More places than this make a long list (see renderServiceArea). */
const LONG_LIST = 12;

/**
 * The places as a ruled list on a board with a brand header, and the hours as a timetable board beside it: the
 * Contact page always says when the business is open, at every width (A16). Side by side, a short list of places
 * ends level with the hours; beside a long one the hours board would end hundreds of pixels above it (judges, A16
 * round 2), so with more than LONG_LIST places the hours sit beside the heading and the places take the whole width
 * under both (area-long).
 * One or two places without hours read as one sentence in a slim band beside the heading, not a full section. When
 * the owner puts this section before the form (A16 U1), its heading carries Call and the call to action, which jumps
 * to the form, so the first screen still offers both (judges, A16 round 1).
 */
export function renderServiceArea(ctx: RenderContext, _variant: VariantOf<"serviceArea">, tone: string): SafeHtml {
  const { facts } = ctx.doc;
  const level = headingLevel(ctx, "serviceArea");
  const actions = level === 1 && html`<div class="head-cta">${callButton(facts, "button-lg")}${quoteButton(ctx, "button-lg")}</div>`;
  const { places, note } = facts.serviceArea;
  const hours = facts.hours.length > 0;
  const few = places.length <= 2;
  const long = hours && places.length > LONG_LIST;
  const hoursBoard =
    hours &&
    html`<div class="board">${itemHeading(level, "board-h", html`${icon("clock", "i")}${facts.emergency247 ? "Office hours" : "Hours"}`)}${hoursTable(facts)}${emergencyNote(facts)}</div>`;
  const areas = few
    ? html`<div class="few"><p class="few-line">${icon("map-pin", "i")}<span>Serving <strong>${fewPlaces(facts)}</strong></span></p>${address(facts, false)}</div>`
    : // A place with one word of 16 or more letters takes a whole row, so it wraps only when wider than the list.
      html`<div class="board">${itemHeading(level, "board-h", html`${icon("map-pin", "i")}Areas we serve`)}<div class="board-body">
<ul class="places">${places.map((place) => html`<li class="place${place.split(/\s+/).some((word) => word.length >= 16) ? " span" : ""}">${place}</li>`)}</ul>
${address(facts, true)}
</div></div>`;

  return html`<section id="${DOM_ID.serviceArea}" class="sec${few && !hours ? " slim" : ""} ${tone}" aria-labelledby="${DOM_ID.serviceArea}-title">
${pageBand(ctx, "serviceArea")}
<div class="${few && !hours ? "wrap slim-in" : long ? "wrap area-long" : "wrap"}">
${head(DOM_ID.serviceArea, hours ? "Service area & hours" : "Service area", note, level, actions)}
<div class="area${hours ? "" : " area--solo"}">${areas}${hoursBoard}</div>
</div>
</section>`;
}

/**
 * The questions as an accordion or open, with a "Still have a question?" Call card beside them, unless the FAQ ends
 * its page: the closing band's Call follows straight after it there (judges, A16 round 1: three Call buttons in a row).
 */
export function renderFaq(ctx: RenderContext, variant: VariantOf<"faq">, tone: string): SafeHtml {
  const { copy, facts } = ctx.doc;
  const level = headingLevel(ctx, "faq");
  const last = ctx.page.sections.at(-1)?.id === "faq";
  const list =
    variant === "accordion"
      ? html`<div class="qa-list">
${copy.faq.map((item, i) => html`<details class="qa" name="faq"${i === 0 && trusted(" open")}><summary>${itemHeading(level, "h3", item.question)}<span class="tog" aria-hidden="true"></span></summary><div class="qa-body"><p>${item.answer}</p></div></details>`)}
</div>`
      : html`<div class="qa-list">
${copy.faq.map((item) => html`<div class="qo">${itemHeading(level, "h3", item.question)}<p>${item.answer}</p></div>`)}
</div>`;
  return html`<section id="${DOM_ID.faq}" class="sec ${tone}" aria-labelledby="${DOM_ID.faq}-title">
${pageBand(ctx, "faq")}
<div class="${last ? "wrap faq faq--solo" : "wrap faq"}">
${head(DOM_ID.faq, "Questions & answers", copy.sectionIntros.faq, level)}
${list}
${!last && html`<div class="faq-more"><p class="faq-more-q">Still have a question?</p>${callButton(facts, "")}</div>`}
</div>
</section>`;
}

/**
 * The heading (the shared contact heading, which turns a one-word call to action into a phrase, with the owner's contact
 * intro, else the hero's subheadline, as its line: a bare "Book" looked unfinished), the call card, the form and the
 * owner's credentials. On phones a compact call card comes first, so calling is one tap from the top of the page (the
 * Contact page's call bar is not sticky, A16) and the form's first fields still share the first screen, and the
 * credentials follow the form; from 1024 px the heading's line sits beside it, the form takes the wide column under it
 * at its own height, and the call card and the credentials sit beside it. The call card is never stretched: without
 * credentials it ends at its content, level with the form's top, and also names the towns the business serves
 * (judges, A16 round 3: a stretched card was a tall, empty brand block beside the form).
 * The <form> is today's field for field (the shared invariant compares it with its class attributes removed): only
 * the classes differ.
 */
export function renderContact(ctx: RenderContext, _variant: VariantOf<"contact">, tone: string): SafeHtml {
  const { facts, copy } = ctx.doc;
  const phone = formatPhone(facts.phone);
  const credentials = credentialList(ctx);
  return html`<section id="${DOM_ID.contact}" class="sec ${tone}" aria-labelledby="${DOM_ID.contact}-title">
${pageBand(ctx, "contact")}
<div class="wrap contact">
${head(DOM_ID.contact, contactHeading(copy.ctaText), copy.sectionIntros.contact ?? copy.heroSubheadline, headingLevel(ctx, "contact"))}
<div class="call-card">
<p class="lbl">Prefer to talk?</p>
<a class="big whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone", "i")}<span><span class="sr-only">Call </span>${keepParts(phone.split(" "))}</span></a>
<ul>
<li><span class="lbl">Email</span><a href="${mailtoUrl(facts.email)}">${emailText(facts.email)}</a></li>
${facts.emergency247 && html`<li><span class="lbl">Emergencies</span>Available 24/7</li>`}${!credentials && onSite(ctx, "serviceArea") && html`<li><span class="lbl">Service area</span>${areaSummary(facts)}</li>`}
</ul>
</div>
<div class="form-card">
<form id="${QUOTE_ID}" class="form" action="${ctx.formAction}" method="post">
<div class="field"><label for="contact-name">Name</label><input id="contact-name" name="name" type="text" autocomplete="name" required maxlength="80" class="input"></div>
<div class="field"><label for="contact-phone">Phone</label><input id="contact-phone" name="phone" type="tel" autocomplete="tel" required maxlength="30" class="input"></div>
<div class="field"><label for="contact-email">Email (optional)</label><input id="contact-email" name="email" type="email" autocomplete="email" maxlength="254" class="input"></div>
<div class="field"><label for="contact-service">Service needed (optional)</label><div class="select"><select id="contact-service" name="service" class="input">
<option value="">Choose a service</option>
${facts.services.map((s) => html`<option>${s.name}</option>`)}
<option>Something else</option>
</select>${icon("chevron-down", "i")}</div></div>
<div class="field full"><label for="contact-message">How can we help? (optional)</label><textarea id="contact-message" name="message" rows="4" maxlength="2000" class="input"></textarea></div>
<div class="hp" aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<div class="form-end"><button type="submit" class="button button-act button-lg">Send request</button></div>
</form>
</div>
${credentials && html`<div class="cred-card"><p class="lbl">Credentials</p>${credentials}</div>`}
</div>
</section>`;
}
