import { escapeAttr, escapeText } from "@asksite/renderer";
import { fixedPageHeaders, rootHostname } from "./headers.ts";

// Fixed pages. Every word is a constant from this file: they never contain a submitted value.
// Each has lang, a title, one h1 inside <main>, and reads well at 320 px (checked by axe in e2e).
// overflow-wrap:break-word (Plan 1's body rule too): abuse@<root> on the apex page has no break
// opportunity, so without it a long root domain scrolls sideways at 320 px (WCAG 1.4.10).

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

// No home link: on a host with no live site, "/" is this same page.
export const notFound = (root: string) =>
  respond(root, 404, page("Page not found", "<p>There is no page at this address. Please check the address and try again.</p>"));

export const unavailable = (root: string) =>
  respond(root, 503, page("Temporarily unavailable", "<p>This page could not be loaded just now. Please try again in a minute.</p>"), { "Retry-After": "60" });

export const thankYou = (root: string) =>
  respond(root, 200, page("Thanks! Your message was sent.", '<p>The business will get back to you soon.</p>\n<p><a href="/">Back to the website</a></p>'));

export const tooManyRequests = (root: string) =>
  respond(
    root,
    429,
    page("Please wait a minute", `<p>We received several messages from you in a short time. Please try again in a minute, or call the business directly.</p>\n${HOME_LINK}`),
    { "Retry-After": "60" },
  );

export const siteBusy = (root: string) =>
  respond(
    root,
    429,
    page("Please call instead", `<p>This business has received a lot of messages today, so the form is closed until tomorrow. Their phone number is on the website.</p>\n${HOME_LINK}`),
    { "Retry-After": "3600" },
  );

export const unreadableForm = (root: string) =>
  respond(root, 415, page("We could not send that", '<p>Your message could not be read. Please go back and try again.</p>\n<p><a href="/#contact">Go back to the form</a></p>'));

/** 413: only a very long message makes a visitor's form this large (A15). */
export const messageTooLong = (root: string) =>
  respond(
    root,
    413,
    page(
      "Your message is too long",
      "<p>Please shorten your message and send it again, or call the business instead. Their phone number is on the website.</p>\n" +
        `<p>Use your browser's Back button to return to the form with what you typed, or <a href="/#contact">go back to the form</a>.</p>`,
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
      `<ul>\n${items}\n</ul>\n<p>Use your browser's Back button to return to the form with what you typed, or <a href="/#contact">go back to the form</a>.</p>`,
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
