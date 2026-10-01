// Modern's service area, questions and contact sections.
import { QUOTE_ID, type Facts, type VariantOf } from "@asksite/site-schema";
import { headingLevel, type RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl } from "../../format.ts";
import { html, trusted, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { itemHeading } from "../../ui.ts";
import { BUILDING } from "./icons.ts";
import { callButton, emailText, emergencyNote, head, hoursTable, keepParts } from "./parts.ts";
import { cityLine, fewPlaces } from "./text.ts";

/** The street address with the building icon, or "Based in …" when the list of places does not already name the home town. */
function address(facts: Facts): SafeHtml | false {
  const { location, serviceArea } = facts;
  if (location.streetAddress !== undefined) return html`<div class="addr">${BUILDING}<address>${location.streetAddress}<br>${cityLine(facts)}</address></div>`;
  const home = location.city.trim().toLowerCase();
  return !serviceArea.places.some((place) => place.trim().toLowerCase() === home) && html`<p class="addr">${BUILDING}<span>Based in ${cityLine(facts)}</span></p>`;
}

/**
 * The places as a ruled list on a board with a brand header, and the hours as a timetable board beside it: the
 * Contact page always says when the business is open, at every width (A16). Each board is as tall as its own
 * content. One or two places without hours read as one sentence in a slim band beside the heading, not a full
 * section.
 */
export function renderServiceArea(ctx: RenderContext, _variant: VariantOf<"serviceArea">, tone: string): SafeHtml {
  const { facts } = ctx.doc;
  const level = headingLevel(ctx, "serviceArea");
  const { places, note } = facts.serviceArea;
  const hours = facts.hours.length > 0;
  const few = places.length <= 2;
  const hoursBoard =
    hours &&
    html`<div class="board">${itemHeading(level, "board-h", html`${icon("clock", "i")}${facts.emergency247 ? "Office hours" : "Hours"}`)}${hoursTable(facts)}${emergencyNote(facts)}</div>`;
  const areas = few
    ? html`<div class="few"><p class="few-line">${icon("map-pin", "i")}<span>Serving <strong>${fewPlaces(facts)}</strong></span></p>${address(facts)}</div>`
    : // A place with one word of 16 or more letters takes a whole row, so it wraps only when wider than the list.
      html`<div class="board">${itemHeading(level, "board-h", html`${icon("map-pin", "i")}Areas we serve`)}<div class="board-body">
<ul class="places">${places.map((place) => html`<li class="place${place.split(/\s+/).some((word) => word.length >= 16) ? " span" : ""}">${place}</li>`)}</ul>
${address(facts)}
</div></div>`;

  return html`<section id="${DOM_ID.serviceArea}" class="sec${few && !hours ? " slim" : ""} ${tone}" aria-labelledby="${DOM_ID.serviceArea}-title">
<div class="wrap${few && !hours ? " slim-in" : ""}">
${head(DOM_ID.serviceArea, hours ? "Service area & hours" : "Service area", note, level)}
<div class="area${hours ? "" : " area--solo"}">${areas}${hoursBoard}</div>
</div>
</section>`;
}

export function renderFaq(ctx: RenderContext, variant: VariantOf<"faq">, tone: string): SafeHtml {
  const { copy, facts } = ctx.doc;
  const level = headingLevel(ctx, "faq");
  const list =
    variant === "accordion"
      ? html`<div class="qa-list">
${copy.faq.map((item, i) => html`<details class="qa" name="faq"${i === 0 && trusted(" open")}><summary>${itemHeading(level, "h3", item.question)}<span class="tog" aria-hidden="true"></span></summary><div class="qa-body"><p>${item.answer}</p></div></details>`)}
</div>`
      : html`<div class="qa-list">
${copy.faq.map((item) => html`<div class="qo">${itemHeading(level, "h3", item.question)}<p>${item.answer}</p></div>`)}
</div>`;
  return html`<section id="${DOM_ID.faq}" class="sec ${tone}" aria-labelledby="${DOM_ID.faq}-title">
<div class="wrap faq">
${head(DOM_ID.faq, "Questions & answers", copy.sectionIntros.faq, level)}
${list}
<div class="faq-more"><p class="faq-more-q">Still have a question?</p>${callButton(facts, "")}</div>
</div>
</section>`;
}

/**
 * The heading, the call card and the form. On phones the call card comes first, so calling is one tap from the top
 * of the page (the Contact page's call bar is not sticky, A16); from 1024 px the form takes the wide column under the
 * heading and the call card sits beside it. The <form> is today's field for field (the shared invariant compares it
 * with its class attributes removed): only the classes differ.
 */
export function renderContact(ctx: RenderContext, _variant: VariantOf<"contact">, tone: string): SafeHtml {
  const { facts, copy } = ctx.doc;
  const phone = formatPhone(facts.phone);
  return html`<section id="${DOM_ID.contact}" class="sec ${tone}" aria-labelledby="${DOM_ID.contact}-title">
<div class="wrap contact">
${head(DOM_ID.contact, copy.ctaText, copy.sectionIntros.contact, headingLevel(ctx, "contact"))}
<div class="call-card">
<p class="lbl">Prefer to talk?</p>
<a class="big whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone", "i")}<span><span class="sr-only">Call </span>${keepParts(phone.split(" "))}</span></a>
<ul>
<li><span class="lbl">Email</span><a href="${mailtoUrl(facts.email)}">${emailText(facts.email)}</a></li>
${facts.emergency247 && html`<li><span class="lbl">Emergencies</span>Available 24/7</li>`}
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
</div>
</section>`;
}
