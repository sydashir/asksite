import { isSafeUrl } from "@asksite/site-schema";
import { createElement, Fragment, type ReactElement } from "react";

export type Segment = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

/** A web address candidate: http(s):// up to whitespace or a character that cannot be part of an address in plain text. */
const URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/g;
/** Sentence punctuation after an address belongs to the sentence. */
const TRAILING = /[.,;:!?)\]]+$/;
/** "Label: https://…" lines, the way packages/app-common/src/emails.ts writes a link in the text part. */
const ACTION_LINE = /^([^:\n]{1,40}): (https:\/\/\S+)$/gm;

/** The email text as plain text and links. Only an https address that passes isSafeUrl becomes a link; everything else stays text. */
export function emailSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  const addText = (value: string) => {
    if (value === "") return;
    const last = segments[segments.length - 1];
    if (last !== undefined && last.kind === "text") last.text += value;
    else segments.push({ kind: "text", text: value });
  };
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const start = match.index;
    const candidate = match[0];
    const url = candidate.replace(TRAILING, "");
    addText(text.slice(at, start));
    if (isSafeUrl(url, ["https:"])) {
      segments.push({ kind: "link", text: url, href: url });
      addText(candidate.slice(url.length));
    } else addText(candidate);
    at = start + candidate.length;
  }
  addText(text.slice(at));
  return segments;
}

/** The short "Label: https://…" lines, shown as buttons above the text. */
export function emailActions(text: string): Array<{ label: string; href: string }> {
  const actions: Array<{ label: string; href: string }> = [];
  for (const match of text.matchAll(ACTION_LINE)) {
    const label = match[1];
    const href = match[2];
    if (label !== undefined && href !== undefined && isSafeUrl(href, ["https:"])) actions.push({ label, href });
  }
  return actions;
}

/** React text nodes and <a> elements only (React escapes text; no raw HTML anywhere). */
export function EmailText({ text }: { text: string }): ReactElement {
  return createElement(
    Fragment,
    null,
    ...emailSegments(text).map((s, i) => (s.kind === "link" ? createElement("a", { key: i, href: s.href, className: "link break-all" }, s.text) : s.text)),
  );
}

export const TAG_LABEL: Readonly<Record<string, string>> = {
  invite: "Invite",
  signup_invite: "Sign-up link",
  magic_link: "Sign-in link",
  review_result: "Review result",
  site_notice: "Site notice",
  admin_alert: "Admin alert",
  lead: "New message",
};
