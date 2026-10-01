import type { OutgoingEmail } from "@asksite/mailer";
import { escapeAttr, escapeText } from "@asksite/renderer";
import type { Lead } from "./lead.ts";

// The lead email (design §7.5). Visitor values only ever become text: escaped text nodes in the
// HTML part, plain lines in the text part. The only link is the site's own address, built from
// its slug. No tracking pixels. Replying goes to the visitor through Reply-To.

const SUBJECT_MAX = 100;

function subjectFor(name: string): string {
  const subject = `New request from your website: ${name}`.replace(/\p{Cc}/gu, "");
  return Array.from(subject).slice(0, SUBJECT_MAX).join("");
}

export function leadEmail(input: { to: string; leadId: string; lead: Lead; siteUrl: string }): OutgoingEmail {
  const { lead, siteUrl } = input;
  const rows: Array<[string, string | null]> = [
    ["Name", lead.name],
    ["Phone", lead.phone],
    ["Email", lead.email],
    ["Service", lead.service],
  ];
  const shown = rows.filter((row): row is [string, string] => row[1] !== null);
  const next = lead.email === null ? "They did not leave an email address, so please call them back." : "Reply to this email to answer them.";

  const text = [
    "You have a new request from your website.",
    "",
    ...shown.map(([label, value]) => `${label}: ${value}`),
    ...(lead.message === null ? [] : ["", "Message:", lead.message]),
    "",
    next,
    "",
    `Sent from the contact form on ${siteUrl}`,
  ].join("\n");

  const html = [
    "<!DOCTYPE html>",
    '<html lang="en"><body style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#1f2937">',
    "<p>You have a new request from your website.</p>",
    "<p>",
    shown.map(([label, value]) => `<strong>${label}:</strong> ${escapeText(value)}`).join("<br>\n"),
    "</p>",
    lead.message === null ? "" : `<p><strong>Message:</strong><br>\n${escapeText(lead.message).replaceAll("\n", "<br>\n")}</p>`,
    `<p>${next}</p>`,
    `<p style="color:#4b5563">Sent from the contact form on <a href="${escapeAttr(siteUrl)}">${escapeText(siteUrl)}</a></p>`,
    "</body></html>",
  ].join("\n");

  return {
    to: input.to,
    subject: subjectFor(lead.name),
    text,
    html,
    ...(lead.email === null ? {} : { replyTo: lead.email }),
    tag: "lead",
    idempotencyKey: `lead:${input.leadId}`,
  };
}
