// The Bold contact band: the heading, "Prefer to talk?" with the big phone number, then the form on a white card
// (the form is the "/contact#quote" target); from 64rem the form sits beside them. A phone visitor sees the number
// and the form's first fields in the first screen, in reading order. When the band opens the Contact page its
// heading is the page's <h1>, the owner's call to action as written (A16).
// The <form> is today's form, field for field, with only its classes changed (A12 §7: the fields, names,
// limits, "Send request" and the honeypot are shared; src/sections/contact.ts, ported from AstroWind). Its own
// opening tag is today's exactly, with no class (the sites Worker's tests read the action from it); the sheet
// styles it as the form card's child.
// Nothing around the form makes a stacking context, so its Send button stays above the call bar
// (styles/shared.css).
import type { VariantOf } from "@asksite/site-schema";
import { headingLevel, type RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { icon as sharedIcon } from "../../icons.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { addressMarkup, bandClass, buttonClass, contactPageHeading, sectionHead } from "./parts.ts";
import { contactHeading } from "./rules.ts";

export function renderContact(ctx: RenderContext, _variant: VariantOf<"contact">): SafeHtml {
  const { facts, copy } = ctx.doc;
  // The AI's intro, or a fixed house line, so a short call to action ("Book") never stands alone as the page's title.
  const intro = copy.sectionIntros.contact ?? "Send a quick request, or call us.";
  const head =
    headingLevel(ctx, "contact") === 1
      ? contactPageHeading(ctx, DOM_ID.contact, intro)
      : sectionHead(DOM_ID.contact, { eyebrow: "Contact", title: contactHeading(copy.ctaText), intro }, "sec-head contact-head");

  return html`<section id="${DOM_ID.contact}" class="${bandClass(ctx, "contact")}" aria-labelledby="${DOM_ID.contact}-title">
<div class="wrap contact">
${head}
<div class="talk">
<p class="kicker">Prefer to talk?</p>
<p><a class="big-phone display whitespace-nowrap" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a></p>
${facts.emergency247 && html`<p><span class="chip">${icon("clock")}24/7 emergency calls</span></p>`}
<p><a class="mail" href="${mailtoUrl(facts.email)}">${icon("mail")}<span>${addressMarkup(facts.email)}</span></a></p>
</div>
<div class="form-card card">
<form id="quote" action="${ctx.formAction}" method="post">
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
</div>
</section>`;
}
