import { describe, expect, it } from "vitest";
import { notFound, siteBusy, thankYou, tooManyRequests } from "../src/pages.ts";

const NOON = Date.parse("2026-09-28T12:00:00.000Z");

// A15 minor 6: the daily limits start again at 00:00 UTC, which is the afternoon or evening of the same
// day in the US, so the page never says "tomorrow" and Retry-After counts the seconds to 00:00 UTC.
describe("the site-busy page (a daily limit refused the form)", () => {
  it.each([
    ["2026-09-28T23:00:00.000Z", "3600"],
    ["2026-09-28T00:00:00.000Z", "86400"],
    ["2026-09-28T17:30:15.500Z", String(6 * 3600 + 29 * 60 + 45)],
    ["2026-09-28T23:59:59.001Z", "1"],
    ["2026-09-28T23:59:59.600Z", "1"], // 0.4 s left: rounded up, never to 0 (a retry before 00:00 would be refused)
  ])("at %s asks the visitor to retry after %s seconds (the next 00:00 UTC)", (at, seconds) => {
    expect(siteBusy("asksite.example", Date.parse(at), null).headers.get("retry-after")).toBe(seconds);
  });

  it("points the visitor to the phone number and never promises a time it cannot keep", async () => {
    const response = siteBusy("asksite.example", NOON, null);
    expect(response.status).toBe(429);
    const body = await response.text();
    expect(body).toContain("<h1>Please call instead</h1>");
    expect(body).toContain("<p>This form cannot take more messages for now. The business's phone number is on the website.</p>");
    expect(body).not.toMatch(/tomorrow|today|tonight/i);
  });

  // A15: the LIVE object carries the business phone (already public on the page), so the page prints it
  // as a link a phone can call instead of sending the visitor back to look for it.
  it("prints the business phone as a tel: link when it knows it", async () => {
    const response = siteBusy("asksite.example", NOON, { text: "(512) 555-0142", tel: "+15125550142" });
    expect(response.status).toBe(429);
    const body = await response.text();
    expect(body).toContain("<h1>Please call instead</h1>");
    expect(body).toContain('<p>This form cannot take more messages for now.</p>\n<p><a href="tel:+15125550142">Call (512) 555-0142</a></p>');
    expect(body).not.toContain("on the website");
    expect(body).not.toMatch(/tomorrow|today|tonight/i);
  });

  it("escapes the phone it prints, in the link text and in the tel: address", async () => {
    const body = await siteBusy("asksite.example", NOON, { text: `<img src=x onerror="alert(1)"> & co`, tel: `+1"><script>alert(1)</script>` }).text();
    expect(body).toContain('<a href="tel:+1&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">Call &lt;img src=x onerror="alert(1)"&gt; &amp; co</a>');
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<script");
  });
});

const PHONE = { text: "(512) 555-0142", tel: "+15125550142" };
const HOSTILE_NAME = `<img src=x onerror="alert(1)"> & 'co'`;

// QA-2 RU(2): the thank-you page names the business the visitor wrote to (the name approveVersion stores
// with the LIVE object), so a homeowner asking several businesses for quotes knows which one this was.
describe("the thank-you page", () => {
  it("names the business and links back to it", async () => {
    const response = thankYou("asksite.example", "Reliable Rooter Plumbing");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<title>Thanks! Your message was sent to Reliable Rooter Plumbing.</title>");
    expect(body).toContain("<h1>Thanks! Your message was sent to Reliable Rooter Plumbing.</h1>\n<p>They will get back to you soon.</p>\n<p><a href=\"/\">Back to Reliable Rooter Plumbing</a></p>");
  });

  it("keeps today's words when it does not know the name (a page approved before the name was stored)", async () => {
    const body = await thankYou("asksite.example", null).text();
    expect(body).toContain('<h1>Thanks! Your message was sent.</h1>\n<p>The business will get back to you soon.</p>\n<p><a href="/">Back to the website</a></p>');
  });

  it.each([
    ["Smith & Co.", "Thanks! Your message was sent to Smith &amp; Co."],
    ["Why Wait?", "Thanks! Your message was sent to Why Wait?"],
    ["Go Green!", "Thanks! Your message was sent to Go Green!"],
    ["Acme Inc", "Thanks! Your message was sent to Acme Inc."],
  ])("ends the sentence once for %s", async (name, heading) => {
    expect(await thankYou("asksite.example", name).text()).toContain(`<h1>${heading}</h1>`);
  });

  it("escapes the name in the title, the heading and the link", async () => {
    const body = await thankYou("asksite.example", HOSTILE_NAME).text();
    const escaped = "&lt;img src=x onerror=\"alert(1)\"&gt; &amp; 'co'";
    expect(body).toContain(`<title>Thanks! Your message was sent to ${escaped}.</title>`);
    expect(body).toContain(`<h1>Thanks! Your message was sent to ${escaped}.</h1>`);
    expect(body).toContain(`<a href="/">Back to ${escaped}</a>`);
    expect(body).not.toContain("<img");
  });
});

// QA-2 RU(3): a wrong path on a live site's host links to the site's page.
describe("the 404 page", () => {
  it("links to the business's page on a live site's host", async () => {
    const response = notFound("asksite.example", "Reliable Rooter Plumbing");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain(
      '<h1>Page not found</h1>\n<p>There is no page at this address. Please check the address and try again.</p>\n<p><a href="/">Go to Reliable Rooter Plumbing\'s page</a></p>',
    );
  });

  it("has no link anywhere else: on a host with no live site, / is this same page", async () => {
    const body = await notFound("asksite.example").text();
    expect(body).toContain("<h1>Page not found</h1>\n<p>There is no page at this address. Please check the address and try again.</p>\n</main>");
    expect(body).not.toContain("<a ");
    expect(await notFound("asksite.example", null).text()).toBe(body);
  });

  it("escapes the name", async () => {
    const body = await notFound("asksite.example", HOSTILE_NAME).text();
    expect(body).toContain(`<a href="/">Go to &lt;img src=x onerror="alert(1)"&gt; &amp; 'co''s page</a>`);
    expect(body).not.toContain("<img");
  });
});

// QA-2 QS(3), RU(4): the per-minute rate limit cannot know whether the day's limits also refuse the visitor,
// so its page promises no time, and it prints the business phone as the daily-limit pages do.
describe("the rate-limit page (5 posts a minute)", () => {
  it("promises no time and prints the business phone as a tel: link", async () => {
    const response = tooManyRequests("asksite.example", PHONE);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    const body = await response.text();
    expect(body).toContain(
      '<h1>Please wait</h1>\n<p>We got several messages from you just now. Please call instead, or try again later.</p>\n<p><a href="tel:+15125550142">Call (512) 555-0142</a></p>',
    );
    expect(body).not.toMatch(/minute|tomorrow|today|tonight|received/i);
  });

  it("points to the phone number on the website when it does not know it", async () => {
    const body = await tooManyRequests("asksite.example", null).text();
    expect(body).toContain("<p>We got several messages from you just now. Please call instead, or try again later. The business's phone number is on the website.</p>");
    expect(body).not.toContain("tel:");
    expect(body).not.toMatch(/minute/i);
  });

  it("escapes the phone it prints", async () => {
    const body = await tooManyRequests("asksite.example", { text: HOSTILE_NAME, tel: `+1"><script>` }).text();
    expect(body).toContain(`<a href="tel:+1&quot;&gt;&lt;script&gt;">Call &lt;img src=x onerror="alert(1)"&gt; &amp; 'co'</a>`);
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<script");
  });
});
