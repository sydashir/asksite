import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// §2.2 / §9.1: owner and visitor text reaches the screen only as React text nodes. This test is
// the lint rule: it fails if any client source file writes raw HTML.
const RAW_HTML = /\b(inner|outer)HTML\b|insertAdjacentHTML|document\.write|setHTMLUnsafe|createContextualFragment|parseFromString|dangerouslySetInnerHTML/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("client source", () => {
  it("never writes raw HTML", () => {
    const root = new URL("../../src/client", import.meta.url).pathname;
    const offenders = files(root).filter((file) => RAW_HTML.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  // F13: each of these is a way to turn text into markup that the earlier pattern let through.
  it.each([
    "<div dangerouslySetInnerHTML={{ __html: x }} />",
    "el.innerHTML = value",
    "el.innerHTML += value",
    'el["innerHTML"] = value',
    "el.outerHTML = value",
    "el.insertAdjacentHTML('beforeend', value)",
    "document.write(value)",
    "el.setHTMLUnsafe(value)",
    "document.createRange().createContextualFragment(value)",
    "new DOMParser().parseFromString(value, 'text/html')",
  ])("the check itself catches a raw-HTML write: %s", (code) => {
    expect(RAW_HTML.test(code)).toBe(true);
  });

  // F13: a preview may show a page in a sandboxed iframe through its srcdoc attribute. That is an attribute, not markup
  // written into this page, so the rule explicitly allows it.
  it("allows the iframe srcdoc attribute of the preview", () => {
    expect(RAW_HTML.test("<iframe sandbox title=\"Preview\" srcDoc={html} />")).toBe(false);
  });
});
