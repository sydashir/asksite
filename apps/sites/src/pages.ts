import { utcDayStart } from "@asksite/core";
import { escapeAttr, escapeText } from "@asksite/renderer";
import { QUOTE_HREF } from "@asksite/site-schema";
import { fixedPageHeaders, rootHostname } from "./headers.ts";

// Fixed pages. Every word is a constant from this file, except escaped values that are never submitted
// ones: the root domain on the apex page, and the business name and phone its approved page shows (from
// the LIVE pointer's metadata) on the thank-you, 404 and "Please call instead" or "Please wait" pages.
// Each has lang, a title, one h1 inside <main>, and reads well at 320 px (checked by axe in e2e).
// overflow-wrap:break-word (Plan 1's body rule too): abuse@<root> on the apex page has no break
// opportunity, so without it a long root domain scrolls sideways at 320 px (WCAG 1.4.10).

// The form is on the Contact page (A16).
const QUOTE = escapeAttr(QUOTE_HREF);

const STYLE =
  "body{margin:0;overflow-wrap:break-word;background:#fff;color:#1f2937;font:1.125rem/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
  "main{max-width:36rem;margin:0 auto;padding:3rem 1.5rem}h1{font-size:1.75rem;line-height:1.25;margin:0 0 1rem;color:#111827}" +
  "a{color:#1d4ed8;text-decoration:underline;text-underline-offset:.15em}a:focus-visible{outline:3px solid #1d4ed8;outline-offset:3px}" +
  "ul{padding-left:1.25rem}li{margin:.25rem 0}p{margin:0 0 1rem}";

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeText(title)}</h1>
${body}
</main>
</body>
</html>
`;
}

function respond(root: string, status: number, html: string, extra: Record<string, string> = {}): Response {
  const headers = fixedPageHeaders(root);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(html, { status, headers });
}

const HOME_LINK = '<p><a href="/">Go to the home page</a></p>';

/**
 * 404. On a live site's host it links to the site's page, named (QA-2 RU(3)); anywhere else it has no link,
 * because on a host with no live site "/" is this same page.
 */
export const notFound = (root: string, business: string | null = null) =>
  respond(
    root,
    404,
    page(
      "Page not found",
      "<p>There is no page at this address. Please check the address and try again.</p>" +
        (business === null ? "" : `\n<p><a href="/">Go to ${escapeText(business)}'s page</a></p>`),
    ),
  );

export const unavailable = (root: string) =>
  respond(root, 503, page("Temporarily unavailable", "<p>This page could not be loaded just now. Please try again in a minute.</p>"), { "Retry-After": "60" });

/** The business's phone as its approved page shows it (the link text) and calls it (the tel: number). */
export interface BusinessPhone {
  text: string;
  tel: string;
}

/** "Name." as the end of a sentence, without a second full stop after "Co." (a name may end in . ! or ?). */
const endSentence = (name: string): string => (/[.!?]$/.test(name) ? name : `${name}.`);

/** The thank-you page names the business the visitor wrote to when it knows it (QA-2 RU(2)). */
export const thankYou = (root: string, business: string | null) =>
  respond(
    root,
    200,
    business === null
      ? page("Thanks! Your message was sent.", '<p>The business will get back to you soon.</p>\n<p><a href="/">Back to the website</a></p>')
      : page(`Thanks! Your message was sent to ${endSentence(business)}`, `<p>They will get back to you soon.</p>\n<p><a href="/">Back to ${escapeText(business)}</a></p>`),
  );

/** A sentence, then the business phone as a tel: link, or, when it is not known, a pointer to the website. */
const withPhone = (sentence: string, phone: BusinessPhone | null): string =>
  phone === null
    ? `<p>${sentence} The business's phone number is on the website.</p>`
    : `<p>${sentence}</p>\n<p><a href="tel:${escapeAttr(phone.tel)}">Call ${escapeText(phone.text)}</a></p>`;

/**
 * 429: the visitor's network sent 5 posts to this form within a minute (FORM_RL). The rate limit runs
 * before the daily limits, so it cannot know whether they refuse the visitor too: the page promises no
 * time (QA-2 QS(3), RU(4)). Retry-After is the rate limit's own window.
 */
export const tooManyRequests = (root: string, phone: BusinessPhone | null) =>
  respond(
    root,
    429,
    page("Please wait", `${withPhone("We got several messages from you just now. Please call instead, or try again later.", phone)}\n${HOME_LINK}`),
    { "Retry-After": "60" },
  );

/** Whole seconds until the next 00:00 UTC, when the form's daily limits start again (at least 1). */
const secondsToNextUtcDay = (now: number): number => Math.ceil((utcDayStart(now) + 86_400_000 - now) / 1000);

/**
 * 429: a daily limit refused the form, the site's own or the visitor's network's (A15). They start again at
 * 00:00 UTC, which is the afternoon or evening of the same day in the US, so the page names no day.
 * The page links the business phone when it is known (null: it points to the number on the website).
 */
export const siteBusy = (root: string, now: number, phone: BusinessPhone | null) =>
  respond(
    root,
    429,
    page("Please call instead", `${withPhone("This form cannot take more messages for now.", phone)}\n${HOME_LINK}`),
    { "Retry-After": String(secondsToNextUtcDay(now)) },
  );

export const unreadableForm = (root: string) =>
  respond(root, 415, page("We could not send that", `<p>Your message could not be read. Please go back and try again.</p>\n<p><a href="${QUOTE}">Go back to the form</a></p>`));

/** 413: only a very long message makes a visitor's form this large (A15). */
export const messageTooLong = (root: string) =>
  respond(
    root,
    413,
    page(
      "Your message is too long",
      "<p>Please shorten your message and send it again, or call the business instead. Their phone number is on the website.</p>\n" +
        `<p>Use your browser's Back button to return to the form with what you typed, or <a href="${QUOTE}">go back to the form</a>.</p>`,
    ),
  );

/** Plain-words problems, chosen by code: the page never repeats what was typed. */
export function formProblems(root: string, problems: readonly string[]): Response {
  const items = problems.map((problem) => `<li>${escapeText(problem)}</li>`).join("\n");
  return respond(
    root,
    400,
    page(
      "Please check your details",
      `<ul>\n${items}\n</ul>\n<p>Use your browser's Back button to return to the form with what you typed, or <a href="${QUOTE}">go back to the form</a>.</p>`,
    ),
  );
}

export function apexPlaceholder(root: string): Response {
  const abuse = `abuse@${rootHostname(root)}`;
  return respond(
    root,
    200,
    page(
      "Websites for local trades",
      `<p>We build and host websites for home-service businesses. Each business has its own address on this domain.</p>\n` +
        `<p>To report a site for phishing, spam or abuse, email <a href="mailto:${escapeAttr(abuse)}">${escapeText(abuse)}</a>.</p>`,
    ),
  );
}
