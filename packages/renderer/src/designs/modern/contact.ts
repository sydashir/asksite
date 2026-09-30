// Modern's service area, questions and contact sections.
import type { Facts, VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl } from "../../format.ts";
import { html, trusted, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { showsHoursInHero } from "./hero.ts";
import { callButton, emergencyNote, FORM_ID, head, hoursTable } from "./parts.ts";
import { cityLine, contactHeading, fewPlaces } from "./text.ts";

/** An email address with a break chance before the @ and each dot, so a long one wraps only there. */
export function emailText(email: string): SafeHtml {
  return html`${email.split(/(?=[@.])/).map((part, i) => html`${i > 0 && html`<wbr>`}${part}`)}`;
}

/** The street address, or "Based in …" when the list of places does not already name the home town. */
function address(facts: Facts): SafeHtml | false {
  const { location, serviceArea } = facts;
  if (location.streetAddress !== undefined) return html`<address class="addr">${location.streetAddress}<br>${cityLine(facts)}</address>`;
  const home = location.city.trim().toLowerCase();
  return !serviceArea.places.some((place) => place.trim().toLowerCase() === home) && html`<p class="addr">Based in ${cityLine(facts)}</p>`;
}

/**
 * The places as a ruled list on a board with a brand header, and the hours as a timetable board beside it.
 * Each board is as tall as its own content. One or two places read as a sentence instead of a board.
 */
export function renderServiceArea(ctx: RenderContext, _variant: VariantOf<"serviceArea">, tone: string): SafeHtml {
  const { facts } = ctx.doc;
  const { places, note } = facts.serviceArea;
  const hours = facts.hours.length > 0 && !showsHoursInHero(ctx);
  const hoursBoard =
    hours &&
    html`<div class="board"><h3 class="board-h">${icon("clock", "i")}${facts.emergency247 ? "Office hours" : "Hours"}</h3>${hoursTable(facts)}${emergencyNote(facts)}</div>`;
  const areas =
    places.length <= 2
      ? html`<div class="few"><p class="few-line">${icon("map-pin", "i")}<span>Serving <strong>${fewPlaces(facts)}</strong></span></p>${address(facts)}</div>`
      : // A place with one word of 16 or more letters takes a whole row, so it wraps only when wider than the list.
        html`<div class="board"><h3 class="board-h">${icon("map-pin", "i")}Areas we serve</h3><div class="board-body">
<ul class="places">${places.map((place) => html`<li class="place${place.split(/\s+/).some((word) => word.length >= 16) ? " span" : ""}">${place}</li>`)}</ul>
${address(facts)}
</div></div>`;

  return html`<section id="${DOM_ID.serviceArea}" class="sec ${tone}" aria-labelledby="${DOM_ID.serviceArea}-title">
<div class="wrap">
${head("serviceArea", hours ? "Service area & hours" : "Service area", note)}
<div class="area${hours ? "" : " area--solo"}">${areas}${hoursBoard}</div>
</div>
</section>`;
}

export function renderFaq(ctx: RenderContext, variant: VariantOf<"faq">, tone: string): SafeHtml {
  const { copy, facts } = ctx.doc;
  const list =
    variant === "accordion"
      ? html`<div class="qa-list">
${copy.faq.map((item, i) => html`<details class="qa" name="faq"${i === 0 && trusted(" open")}><summary><h3 class="h3">${item.question}</h3><span class="tog" aria-hidden="true"></span></summary><div class="qa-body"><p>${item.answer}</p></div></details>`)}
</div>`
      : html`<div class="qa-list">
${copy.faq.map((item) => html`<div class="qo"><h3 class="h3">${item.question}</h3><p>${item.answer}</p></div>`)}
</div>`;
  return html`<section id="${DOM_ID.faq}" class="sec ${tone}" aria-labelledby="${DOM_ID.faq}-title">
<div class="wrap faq">
${head("faq", "Questions & answers", copy.sectionIntros.faq)}
${list}
<div class="faq-more"><p class="faq-more-q">Still have a question?</p>${callButton(facts, "")}</div>
</div>
</section>`;
}

/**
 * The form, then the call card beside it (from 1024 px). The <form> is today's field for field (the shared
 * invariant compares it with its class attributes removed): only the classes differ.
 */
export function renderContact(ctx: RenderContext, _variant: VariantOf<"contact">, tone: string): SafeHtml {
  const { facts, copy } = ctx.doc;
  const phone = formatPhone(facts.phone);
  return html`<section id="${DOM_ID.contact}" class="sec ${tone}" aria-labelledby="${DOM_ID.contact}-title">
<div class="wrap contact">
<div class="contact-main" id="${FORM_ID}">
${head("contact", contactHeading(copy.ctaText), copy.sectionIntros.contact)}
<div class="form-card">
<form class="form" action="${ctx.formAction}" method="post">
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
<div class="call-card">
<p class="lbl">Prefer to talk?</p>
<a class="big whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone", "i")}<span><span class="sr-only">Call </span>${phone}</span></a>
<ul>
<li><span class="lbl">Email</span><a href="${mailtoUrl(facts.email)}">${emailText(facts.email)}</a></li>
${facts.emergency247 && html`<li><span class="lbl">Emergencies</span>Available 24/7</li>`}
</ul>
</div>
</div>
</section>`;
}
