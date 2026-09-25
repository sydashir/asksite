import { describe, expect, it } from "vitest";
import {
  adminAlertEmail,
  cleanSubject,
  inviteEmail,
  magicLinkEmail,
  reviewApprovedEmail,
  reviewRejectedEmail,
  siteNoticeEmail,
} from "../src/emails.ts";

const APP = "https://app.asksite.example";
const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"; // 43 base64url characters
const XSS = `<img src=x onerror=alert(1)> "quoted" & 'single'`;

/** Every href in the HTML part. */
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("cleanSubject", () => {
  it("removes CR, LF and other control characters and caps the length", () => {
    expect(cleanSubject("Hello\r\nBcc: victim@example.com\u0000!")).toBe("Hello Bcc: victim@example.com !");
    expect(cleanSubject("x".repeat(150))).toHaveLength(100);
  });
});

describe("inviteEmail", () => {
  it("links to the invite page with the token in the fragment and says it expires", () => {
    const email = inviteEmail({ appOrigin: APP, token: TOKEN });
    expect(email.subject).toBe("You're invited to set up your business website");
    expect(email.text).toContain(`${APP}/invite#${TOKEN}`);
    expect(email.text).toContain("7 days");
    expect(hrefs(email.html)).toEqual([`${APP}/invite#${TOKEN}`]);
  });

  it("refuses a malformed token or a non-https origin instead of building a bad link", () => {
    expect(() => inviteEmail({ appOrigin: APP, token: "short" })).toThrow("Invalid token");
    expect(() => inviteEmail({ appOrigin: "javascript:alert(1)", token: TOKEN })).toThrow("Invalid origin");
    expect(() => inviteEmail({ appOrigin: "http://app.asksite.example", token: TOKEN })).toThrow("Invalid origin");
  });
});

describe("magicLinkEmail", () => {
  it("links to the login page and says it lasts 15 minutes", () => {
    const email = magicLinkEmail({ appOrigin: APP, token: TOKEN });
    expect(email.subject).toBe("Your sign-in link");
    expect(email.text).toContain(`${APP}/login#${TOKEN}`);
    expect(email.text).toContain("15 minutes");
    expect(hrefs(email.html)).toEqual([`${APP}/login#${TOKEN}`]);
  });
});

describe("review result emails", () => {
  it("approved: links to the live site and the app", () => {
    const email = reviewApprovedEmail({ appOrigin: APP, liveUrl: "https://joes-plumbing.asksite.example/" });
    expect(email.subject).toBe("Your website is live");
    expect(hrefs(email.html)).toEqual(["https://joes-plumbing.asksite.example/", APP]);
  });

  it("rejected: shows the reviewer's note as escaped text, never as markup", () => {
    const email = reviewRejectedEmail({ appOrigin: APP, note: XSS });
    expect(email.subject).toBe("Your website needs a change before it goes live");
    expect(email.text).toContain(XSS);
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.html).not.toContain("<img");
    expect(hrefs(email.html)).toEqual([APP]);
  });
});

describe("siteNoticeEmail", () => {
  it("includes the admin's message escaped, and always says where to ask", () => {
    const withMessage = siteNoticeEmail({ appOrigin: APP, supportEmail: "help@asksite.example", ownerMessage: XSS });
    expect(withMessage.subject).toBe("Your website has been taken offline");
    expect(withMessage.html).not.toContain("<img");
    expect(withMessage.html).toContain("&lt;img");
    const without = siteNoticeEmail({ appOrigin: APP, supportEmail: "help@asksite.example", ownerMessage: null });
    expect(without.text).toContain("If you have questions, reply to this email or write to help@asksite.example.");
    expect(hrefs(without.html)).toEqual([APP]);
    expect(() => siteNoticeEmail({ appOrigin: APP, supportEmail: "help desk", ownerMessage: null })).toThrow("Invalid support email");
  });
});

describe("the support address check", () => {
  it("refuses anything after a valid address (the pattern is anchored at the end)", () => {
    for (const supportEmail of ["help@asksite.example evil", "help@asksite.example\nBcc: x@evil.example", "help@asksite.example>"]) {
      expect(() => siteNoticeEmail({ appOrigin: APP, supportEmail, ownerMessage: null })).toThrow("Invalid support email");
    }
  });
});

describe("links", () => {
  it("escape the href as an attribute value", () => {
    const email = reviewApprovedEmail({ appOrigin: APP, liveUrl: `https://joes-plumbing.asksite.example/?a=1&b="x"'<y>` });
    expect(email.html).toContain(`<a href="https://joes-plumbing.asksite.example/?a=1&amp;b=&quot;x&quot;&#39;&lt;y&gt;">`);
  });
});

describe("adminAlertEmail", () => {
  it("names the site by its slug in the subject and escapes the business name", () => {
    const email = adminAlertEmail({ slug: "joes-plumbing", versionNumber: 3, businessName: XSS });
    expect(email.subject).toBe("Website waiting for review: joes-plumbing (version 3)");
    expect(email.html).not.toContain("<img");
    expect(email.text).toContain(XSS);
    expect(hrefs(email.html)).toEqual([]);
  });
});

describe("every template", () => {
  it("has no tracking pixel, no script and no style", () => {
    for (const email of [
      inviteEmail({ appOrigin: APP, token: TOKEN }),
      magicLinkEmail({ appOrigin: APP, token: TOKEN }),
      reviewApprovedEmail({ appOrigin: APP, liveUrl: "https://a-b.asksite.example/" }),
      reviewRejectedEmail({ appOrigin: APP, note: "Please fix the phone number." }),
      siteNoticeEmail({ appOrigin: APP, supportEmail: "help@asksite.example", ownerMessage: null }),
      adminAlertEmail({ slug: "abc", versionNumber: 1, businessName: null }),
    ]) {
      expect(email.html).not.toMatch(/<img|<script|<style|<iframe/i);
      expect(email.subject).not.toMatch(/[\r\n]/);
    }
  });
});
