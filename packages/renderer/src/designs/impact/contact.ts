// The Bold contact band: the heading (the #quote target), the form on a white card, then "Prefer to talk?"
// with the big phone number; from 64rem the form sits beside them.
// The <form> is today's form, field for field, with only its classes changed (A12 §7: the fields, names,
// limits, "Send request" and the honeypot are shared; src/sections/contact.ts, ported from AstroWind).
// Nothing around the form makes a stacking context, so its Send button stays above the call bar
// (styles/shared.css).
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { icon as sharedIcon } from "../../icons.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { addressMarkup, bandClass, buttonClass } from "./parts.ts";
import { contactHeading } from "./rules.ts";

export function renderContact(ctx: RenderContext, _variant: VariantOf<"contact">): SafeHtml {
  const { facts, copy } = ctx.doc;
  const intro = copy.sectionIntros.contact;

  return html`<section id="${DOM_ID.contact}" class="${bandClass(ctx, "contact")}" aria-labelledby="${DOM_ID.contact}-title">
<div class="wrap contact">
<div class="sec-head contact-head" id="quote"><p class="kicker eyebrow">Contact</p><h2 id="${DOM_ID.contact}-title" class="h2 display">${contactHeading(copy.ctaText)}</h2>${intro && html`<p class="sec-intro">${intro}</p>`}</div>
<div class="form-card card">
<form class="fields" action="${ctx.formAction}" method="post">
<div class="field"><label for="contact-name">Name</label><input id="contact-name" name="name" type="text" autocomplete="name" required maxlength="80" class="input"></div>
<div class="field"><label for="contact-phone">Phone</label><input id="contact-phone" name="phone" type="tel" autocomplete="tel" required maxlength="30" class="input"></div>
<div class="field"><label for="contact-email">Email (optional)</label><input id="contact-email" name="email" type="email" autocomplete="email" maxlength="254" class="input"></div>
<div class="field"><label for="contact-service">Service needed (optional)</label><div class="select-wrap"><select id="contact-service" name="service" class="input">
<option value="">Choose a service</option>
${facts.services.map((s) => html`<option>${s.name}</option>`)}
<option>Something else</option>
</select>${sharedIcon("chevron-down", "ic")}</div></div>
<div class="field field--full"><label for="contact-message">How can we help? (optional)</label><textarea id="contact-message" name="message" rows="4" maxlength="2000" class="input"></textarea></div>
<div class="hp" aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<div class="field--full"><button type="submit" class="${buttonClass(ctx, "action", true)} send">Send request</button></div>
</form>
</div>
<div class="talk">
<p class="kicker">Prefer to talk?</p>
<p><a class="big-phone display whitespace-nowrap" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a></p>
${facts.emergency247 && html`<p><span class="chip">${icon("clock")}24/7 emergency calls</span></p>`}
<p><a class="mail" href="${mailtoUrl(facts.email)}">${icon("mail")}<span>${addressMarkup(facts.email)}</span></a></p>
</div>
</div>
</section>`;
}
