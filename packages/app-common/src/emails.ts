import { TOKEN_PATTERN } from "@asksite/core";
import { escapeAttr, escapeText } from "@asksite/renderer";
import { isSafeUrl } from "@asksite/site-schema";

// Email templates owned by Plan 4 (design §7.6). Plain text plus minimal escaped HTML, no images,
// no tracking. Every value a person typed (a business name, an admin's note) reaches the HTML only
// as escaped text. Links are built only from our own origins, validated tokens and slugs.

export interface EmailContent {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

type Part = string | { readonly href: string; readonly label: string };

/** Removes CR, LF and every other control or invisible formatting character, then caps the length. */
export function cleanSubject(subject: string, max = 100): string {
  return subject.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function assertOrigin(origin: string): void {
  if (!isSafeUrl(origin, ["https:"]) || new URL(origin).origin !== origin) throw new Error("Invalid origin");
}

function assertToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid token");
}

/** The support mailbox is shown as text and used as Reply-To, so it must be one plain address. */
function assertSupportEmail(email: string): void {
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(email)) throw new Error("Invalid support email");
}

const paragraph = (text: string): string => `<p>${escapeText(text).replaceAll("\n", "<br>")}</p>`;

function build(subject: string, parts: readonly Part[]): EmailContent {
  const text = parts.map((part) => (typeof part === "string" ? part : `${part.label}: ${part.href}`)).join("\n\n");
  const body = parts
    .map((part) =>
      typeof part === "string" ? paragraph(part) : `<p><a href="${escapeAttr(part.href)}">${escapeText(part.label)}</a></p>`,
    )
    .join("\n");
  return { subject: cleanSubject(subject), text: `${text}\n`, html: `<!doctype html>\n<html lang="en"><body>\n${body}\n</body></html>\n` };
}

export function inviteEmail(input: { appOrigin: string; token: string }): EmailContent {
  assertOrigin(input.appOrigin);
  assertToken(input.token);
  const link = `${input.appOrigin}/invite#${input.token}`;
  return build("You're invited to set up your business website", [
    "Hi,",
    "You have been invited to build a website for your business. It takes about 15 minutes.",
    { href: link, label: "Set up your website" },
    `If the link does not open, copy this address into your browser: ${link}`,
    "The link works once and expires in 7 days. If you were not expecting this email, you can ignore it.",
  ]);
}

export function magicLinkEmail(input: { appOrigin: string; token: string }): EmailContent {
  assertOrigin(input.appOrigin);
  assertToken(input.token);
  const link = `${input.appOrigin}/login#${input.token}`;
  return build("Your sign-in link", [
    "Hi,",
    { href: link, label: "Sign in to your website" },
    `If the link does not open, copy this address into your browser: ${link}`,
    "The link works once and expires in 15 minutes. If you did not ask to sign in, you can ignore this email.",
  ]);
}

export function reviewApprovedEmail(input: { appOrigin: string; liveUrl: string }): EmailContent {
  assertOrigin(input.appOrigin);
  if (!isSafeUrl(input.liveUrl, ["https:"])) throw new Error("Invalid live URL");
  return build("Your website is live", [
    "Good news: we checked your website and it is now live. It can take about a minute to appear everywhere.",
    { href: input.liveUrl, label: "Open your website" },
    "You can keep editing it. Changes go live after we check them again.",
    { href: input.appOrigin, label: "Open your dashboard" },
  ]);
}

export function reviewRejectedEmail(input: { appOrigin: string; note: string }): EmailContent {
  assertOrigin(input.appOrigin);
  return build("Your website needs a change before it goes live", [
    "We checked your website and it needs a change before it can go live. Our note:",
    input.note,
    "Make the change and press Publish again.",
    { href: input.appOrigin, label: "Open your dashboard" },
  ]);
}

/** The takedown notice. The app never shows the internal reason, so this says only what the owner can act on. */
export function siteNoticeEmail(input: { appOrigin: string; supportEmail: string; ownerMessage: string | null }): EmailContent {
  assertOrigin(input.appOrigin);
  assertSupportEmail(input.supportEmail);
  return build("Your website has been taken offline", [
    "We have taken your website offline, so visitors cannot see it for now.",
    ...(input.ownerMessage === null ? [] : [input.ownerMessage]),
    `If you have questions, reply to this email or write to ${input.supportEmail}.`,
    { href: input.appOrigin, label: "Open your dashboard" },
  ]);
}

export function adminAlertEmail(input: { slug: string; versionNumber: number; businessName: string | null }): EmailContent {
  return build(`Website waiting for review: ${input.slug} (version ${input.versionNumber})`, [
    `A website is waiting for review. Business: ${input.businessName ?? "(no name yet)"}. Address: ${input.slug}. Version ${input.versionNumber}.`,
    "Open the review queue in the admin app to check it.",
  ]);
}
