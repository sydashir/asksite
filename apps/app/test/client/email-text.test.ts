import { inviteEmail, magicLinkEmail, signupInviteEmail } from "@asksite/app-common";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emailActions, EmailText } from "../../src/client/dev/email-text.ts";

const render = (text: string) => renderToStaticMarkup(createElement(EmailText, { text }));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const TOKEN = "Abc_def-0123456789ABCDEFGHIJKLMNOPQRSTUVWxyz".slice(0, 43).padEnd(43, "x");
const ORIGIN = "https://app.localhost:8787";

describe("EmailText", () => {
  it("escapes markup in the text", () => {
    const html = render("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  it("keeps a javascript: address as text", () => {
    const html = render("javascript:alert(1)");
    expect(html).not.toContain("<a");
    expect(html).toContain("javascript:alert(1)");
  });

  it("stops an address at a quote and escapes the rest", () => {
    const html = render('https://ok.localhost/a"><script>alert(1)</script>');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(hrefs(html)).toEqual(["https://ok.localhost/a"]);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script");
  });

  it("links https only", () => {
    const html = render("http://plain.example/");
    expect(html).not.toContain("<a");
    expect(html).toContain("http://plain.example/");
  });

  it("keeps scheme-without-slashes addresses as text", () => {
    expect(render("https:evil.example/x")).not.toContain("<a");
    expect(render("https:/\\evil")).not.toContain("<a");
  });

  it("keeps an address with a control character as text", () => {
    expect(render("https://x.localhost/\u0001a")).not.toContain("<a");
  });

  it("leaves sentence punctuation outside the link", () => {
    const html = render("See https://app.localhost:8787/login#tok.");
    expect(hrefs(html)).toEqual(["https://app.localhost:8787/login#tok"]);
    expect(html).toContain("</a>.");
  });

  it("links exactly the safe https addresses of a mixed hostile body", () => {
    const html = render(
      [
        "Open https://a.localhost/one and https://b.localhost/two, then",
        "http://c.localhost/x javascript:alert(1) <a href=\"https://evil.example\">x</a>",
        "https:evil.example/y https://d.localhost/\u0001z",
      ].join("\n"),
    );
    const found = hrefs(html);
    expect(html.match(/<a /g)?.length).toBe(found.length);
    expect(found).toEqual(["https://a.localhost/one", "https://b.localhost/two", "https://evil.example"]);
    for (const href of found) expect(href?.startsWith("https://")).toBe(true);
  });
});

describe("emailActions", () => {
  it("finds the one action of a real invite, sign-in and sign-up email", () => {
    expect(emailActions(inviteEmail({ appOrigin: ORIGIN, token: TOKEN }).text)).toEqual([{ label: "Set up your website", href: `${ORIGIN}/invite#${TOKEN}` }]);
    expect(emailActions(magicLinkEmail({ appOrigin: ORIGIN, token: TOKEN }).text)).toEqual([{ label: "Sign in to your website", href: `${ORIGIN}/login#${TOKEN}` }]);
    expect(emailActions(signupInviteEmail({ appOrigin: ORIGIN, token: TOKEN }).text)).toEqual([{ label: "Set up your website", href: `${ORIGIN}/invite#${TOKEN}` }]);
  });

  it("refuses unsafe addresses", () => {
    expect(emailActions("Click: javascript:alert(1)\nOpen: http://x/")).toEqual([]);
    // An https line that isSafeUrl refuses (a control character inside) is not an action either.
    expect(emailActions("Open: https://x.localhost/\u0001a")).toEqual([]);
  });
});
