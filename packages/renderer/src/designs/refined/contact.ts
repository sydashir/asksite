// Classic's contact band: the owner's call to action, word for word, as the heading (the Contact page's <h1> when the
// band opens it, A16), the owner's own contact line (or a plain house line), the phone large, then the email and,
// from 60rem, the license and Insured beside the form. The towns, the hours and the address have one home on this
// page, the Service area section; the band names the owner's base only when that section is hidden. When the band
// opens the page the form always sits beside the facts, so the whole form and Send are on a desktop's first screen;
// lower on the page, an owner with too little on file to balance the form gets one centred column. Every "Get a
// quote" link lands on the form (id "quote"). The form is today's form field for field (the shared invariants
// compare it with every class removed): ported from AstroWind (MIT, see NOTICES.md) through sections/contact.ts; only
// its classes are Classic's.
import { QUOTE_ID } from "@asksite/site-schema";
import { headingLevel, type RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { contactLine, dots, email, icon, lic, sectionTitle } from "./parts.ts";
import { plan } from "./plan.ts";

/** Fewer rows than this beside the form cannot balance it, so a band lower on the page stacks (from 60rem). */
const STACK_BELOW = 8;

export function renderContact(ctx: RenderContext): SafeHtml {
  const { doc } = ctx;
  const { facts, copy } = doc;
  const { location } = facts;
  const { areaShown, trustShown } = plan(ctx);
  // The address and the towns live in the Service area section on this page; the band names the base only without it.
  const showWhere = !areaShown;
  const where = location.streetAddress
    ? `${location.streetAddress}, ${location.city}, ${location.state}${location.postalCode ? ` ${location.postalCode}` : ""}`
    : `Based in ${location.city}, ${location.state}`;
  const first = facts.licences[0];
  const credentials = trustShown
    ? [...(first ? [{ text: html`License ${lic(first.number)}` }] : []), ...(facts.insured ? [{ text: "Insured" }] : [])]
    : [];
  const rows = 4 + (facts.emergency247 ? 1 : 0) + (showWhere ? 1 : 0) + (credentials.length > 0 ? 1 : 0);

  return html`<section id="${DOM_ID.contact}" class="sec dark" aria-labelledby="${DOM_ID.contact}-title">
<div class="${rows < STACK_BELOW && headingLevel(ctx, "contact") === 2 ? "wr contact c-stack" : "wr contact"}">
<div class="c-info">
${sectionTitle(ctx, "contact", copy.ctaText, contactLine(doc))}
<ul class="c-list">
<li>${icon("phone", "i i-lg")}<span><a class="c-ph whitespace-nowrap" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a>${facts.emergency247 && html`<span class="c-note">24/7 emergency service</span>`}</span></li>
<li>${icon("mail")}<a href="${mailtoUrl(facts.email)}">${email(facts.email)}</a></li>
${showWhere && html`<li>${icon("store")}<span>${where}</span></li>`}
${credentials.length > 0 && html`<li class="c-more">${icon("shield-check")}${dots(credentials)}</li>`}
</ul>
</div>
<div class="fcard">
<form id="${QUOTE_ID}" action="${ctx.formAction}" method="post">
<div class="f"><label for="contact-name">Name</label><input id="contact-name" name="name" type="text" autocomplete="name" required maxlength="80" class="in"></div>
<div class="f"><label for="contact-phone">Phone</label><input id="contact-phone" name="phone" type="tel" autocomplete="tel" required maxlength="30" class="in"></div>
<div class="f"><label for="contact-email">Email (optional)</label><input id="contact-email" name="email" type="email" autocomplete="email" maxlength="254" class="in"></div>
<div class="f"><label for="contact-service">Service needed (optional)</label><div class="sel"><select id="contact-service" name="service" class="in">
<option value="">Choose a service</option>
${facts.services.map((s) => html`<option>${s.name}</option>`)}
<option>Something else</option>
</select>${icon("chevron-down", "sel-i")}</div></div>
<div class="f f-w"><label for="contact-message">How can we help? (optional)</label><textarea id="contact-message" name="message" rows="4" maxlength="2000" class="in"></textarea></div>
<div class="hp" aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<div class="f-w"><button type="submit" class="bt bt-act bt-lg">Send request</button></div>
</form>
<p class="fcall"><span>Prefer to talk?</span> <a class="whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone")}Call ${formatPhone(facts.phone)}</a>${facts.emergency247 && html` <span class="fcall-n">24/7 emergency service</span>`}</p>
</div>
</div>
</section>`;
}
