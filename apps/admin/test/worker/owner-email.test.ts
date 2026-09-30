import type { EmailContent } from "@asksite/app-common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerEmailOrSkip } from "../../src/worker/owner-email.ts";

// The owner's review email is built after approve or reject has changed the site. A build error must not turn that
// done change into an error (moderator ruling P4-23 item 4, option (a), 2026-09-30): the email is skipped, and one
// line says why, with ids and a reason code only.

const CONTENT: EmailContent = { subject: "Your website is live", text: "Open your website\n", html: "<p>Open your website</p>\n" };
const IDS = { versionId: "version-1", siteId: "site-1" };

/** The build error's message may hold a live address or an email; neither may reach the log. */
const failingBuild = (): EmailContent => {
  throw new Error("Invalid live URL https://secret-slug.example/ owner@example.com");
};

function logSpy() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

const logged = (spy: ReturnType<typeof logSpy>) => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ownerEmailOrSkip", () => {
  it("returns the email the build gives, and logs nothing", () => {
    const spy = logSpy();
    expect(ownerEmailOrSkip(() => CONTENT, { reason: "invalid_live_url", ...IDS })).toBe(CONTENT);
    expect(spy).not.toHaveBeenCalled();
  });

  it("after an approval, skips an email that cannot be built and logs invalid_live_url with the ids only", () => {
    const spy = logSpy();
    expect(ownerEmailOrSkip(failingBuild, { reason: "invalid_live_url", ...IDS })).toBeNull();
    expect(logged(spy)).toEqual([{ event: "owner_email_skipped", reason: "invalid_live_url", versionId: "version-1", siteId: "site-1" }]);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret-slug|owner@example\.com|Invalid live URL/);
  });

  it("after a rejection, skips an email that cannot be built and logs email_build_failed with the ids only", () => {
    const spy = logSpy();
    expect(ownerEmailOrSkip(failingBuild, { reason: "email_build_failed", ...IDS })).toBeNull();
    expect(logged(spy)).toEqual([{ event: "owner_email_skipped", reason: "email_build_failed", versionId: "version-1", siteId: "site-1" }]);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret-slug|owner@example\.com|Invalid live URL/);
  });
});
