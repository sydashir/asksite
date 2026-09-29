import { hashIp, LIMITS, newId } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { at, linesWith, PHONE_METADATA, putLive, seedSite, settledLeads, sitesHarness, TEST_SECRETS, type SeededSite, type ToolsEnv } from "./support/harness.ts";

const harness = sitesHarness();
let tools: ToolsEnv;
beforeAll(async () => {
  ({ tools } = await harness.start());
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

const GOOD = { name: "Dana Price", phone: "(512) 555-0199", email: "dana@example.com", service: "Drain cleaning", message: "Kitchen sink\r\nis blocked.", website: "" };
let ipCounter = 0;
/** Each call gets its own visitor IP unless one is given, so the per-IP rate limit only bites where a test wants it. */
function post(site: { slug: string; siteId: string }, fields: Record<string, string>, init: { ip?: string; headers?: Record<string, string>; body?: string } = {}) {
  ipCounter += 1;
  return harness.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": init.ip ?? `198.51.100.${ipCounter}`, ...init.headers },
    body: init.body ?? new URLSearchParams(fields).toString(),
  });
}

/** A response as "<status>", plus the page's heading for a 429 (the two 429 pages differ only in their words). */
async function pageOf(response: { status: number; text(): Promise<string> }): Promise<string> {
  if (response.status !== 429) return String(response.status);
  return `429 ${/<h1>([^<]*)<\/h1>/.exec(await response.text())?.[1] ?? "?"}`;
}

async function leads(siteId: string) {
  const { results } = await tools.DB.prepare("SELECT * FROM leads WHERE site_id = ? ORDER BY created_at").bind(siteId).all<Record<string, unknown>>();
  return results;
}

async function outboxFor(to: string) {
  const { results } = await tools.DB.prepare("SELECT to_addr, subject, text, tag FROM dev_outbox WHERE to_addr = ? ORDER BY id").bind(to).all<Record<string, string>>();
  return results;
}

describe("POST /_f/<siteId>", () => {
  let site: SeededSite;
  beforeAll(async () => {
    site = await seedSite(tools);
  });

  it("stores the lead, emails the owner's login email and redirects to the thank-you page", async () => {
    const response = await post(site, GOOD, { ip: "203.0.113.7" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/_f/${site.siteId}/sent`);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");

    const [lead] = await settledLeads(tools, site.siteId);
    expect(lead).toMatchObject({
      name: "Dana Price", phone: "(512) 555-0199", email: "dana@example.com", service: "Drain cleaning",
      message: "Kitchen sink\nis blocked.", spam: 0, email_status: "sent", email_error: null,
      ip_hash: await hashIp(TEST_SECRETS.IP_HASH_KEY, "203.0.113.7"),
    });
    expect(JSON.stringify(lead)).not.toContain("203.0.113.7");

    const [email] = await outboxFor(site.ownerEmail);
    expect(email).toMatchObject({ to_addr: site.ownerEmail, subject: "New request from your website: Dana Price", tag: "lead" });
    expect(email?.text).toContain("Phone: (512) 555-0199");
    expect(email?.text).toContain(`Sent from the contact form on https://${site.slug}.localhost:8789/`);
  });

  it("shows the thank-you page", async () => {
    const response = await harness.server.fetch(at(site.slug, `/_f/${site.siteId}/sent`));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toContain("<h1>Thanks! Your message was sent.</h1>");
  });

  it("drops a bot that filled the honeypot but still thanks it", async () => {
    const quiet = await seedSite(tools);
    const response = await post(quiet, { ...GOOD, website: "https://spam.example" });
    expect(response.status).toBe(303);
    expect(await leads(quiet.siteId)).toEqual([]);
  });

  it("lists problems in plain words without repeating what was typed", async () => {
    const fresh = await seedSite(tools);
    const response = await post(fresh, { name: "", phone: "<script>alert(1)</script>", email: "not-an-email", message: "x".repeat(2001) });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const body = await response.text();
    expect(body).toContain("<li>Please enter your name (up to 80 characters).</li>");
    expect(body).toContain("<li>Please enter a phone number we can call back, with at least 7 digits. Use only digits, spaces, dashes, dots, parentheses and a plus sign, and leave out any extension.</li>");
    expect(body).toContain("<li>Please check your email address, or leave it empty.</li>");
    expect(body).toContain("<li>Please shorten your message to 2,000 characters or fewer.</li>");
    expect(body).not.toContain("script");
    expect(body).not.toContain("not-an-email");
    expect(body).toContain('href="/#contact"');
    expect(await leads(fresh.siteId)).toEqual([]);
  });

  it("refuses other content types (415) and bodies over 24 KiB (413)", async () => {
    expect((await post(site, {}, { headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(415);
    expect((await post(site, {}, { headers: { "content-type": "multipart/form-data; boundary=x" }, body: "x" })).status).toBe(415);
    expect((await post(site, {}, { body: `message=${"a".repeat(25 * 1024)}` })).status).toBe(413);
  });

  // A15 minor 1: only a very long message can make a visitor's body this large, so the page says so.
  it("tells a visitor whose body is too large that the message is too long, to shorten it or call", async () => {
    const response = await post(site, {}, { body: `message=${"a".repeat(25 * 1024)}` });
    expect(response.status).toBe(413);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const body = await response.text();
    expect(body).toContain("<h1>Your message is too long</h1>");
    expect(body).toContain("Please shorten your message and send it again, or call the business instead.");
    expect(body).toContain('href="/#contact"');
  });

  // A15 minor 1: the form allows 2,000 characters (maxlength and lead.ts). A character of a 3-byte
  // script (Chinese, Japanese, Korean, Hindi, Thai) is 9 bytes once form-encoded, so 2,000 of them with
  // every other field at its costliest valid maximum is the largest body a visitor can send.
  it("accepts the largest body a visitor can send: 2,000 CJK characters and every other field at its maximum", async () => {
    const target = await seedSite(tools);
    const cjk = (n: number) => "漢".repeat(n);
    const fields = {
      name: cjk(80),
      phone: `${"+".repeat(23)}5125550`, // 30 characters, 7 digits; "+" is 3 bytes encoded
      email: `${"'".repeat(248)}+@a.co`, // 254 characters; ' and + are the costliest characters an email may hold
      service: cjk(60),
      message: cjk(2000),
      website: "",
    };
    const body = new URLSearchParams(fields).toString();
    expect(body.length).toBeGreaterThan(16 * 1024);
    expect(body.length).toBeLessThanOrEqual(24 * 1024);
    expect((await post(target, {}, { body })).status).toBe(303);
    const [lead] = await leads(target.siteId);
    expect(lead).toMatchObject({ name: fields.name, phone: fields.phone, email: fields.email, service: fields.service, message: fields.message });
  });

  // A15: the 4th and 5th posts from one network on one site are refused by its daily limit ("Please call
  // instead"); they still count toward the rate limit, which refuses the 6th ("Please wait a minute").
  it("rate-limits one visitor to 5 posts a minute per site", async () => {
    const busy = await seedSite(tools);
    const pages: string[] = [];
    for (let i = 0; i < 6; i++) pages.push(await pageOf(await post(busy, GOOD, { ip: "192.0.2.44" })));
    expect(pages).toEqual(["303", "303", "303", "429 Please call instead", "429 Please call instead", "429 Please wait a minute"]);
    const limited = await post(busy, GOOD, { ip: "192.0.2.44" });
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await post(busy, GOOD, { ip: "192.0.2.45" })).status).toBe(303);
    expect(await leads(busy.siteId)).toHaveLength(4);
  });

  it("rate-limits an IPv6 visitor by the /64 network, not the full address", async () => {
    const busy = await seedSite(tools);
    const pages: string[] = [];
    for (let i = 1; i <= 6; i++) pages.push(await pageOf(await post(busy, GOOD, { ip: `2001:db8:4:7::${i}` })));
    expect(pages).toEqual(["303", "303", "303", "429 Please call instead", "429 Please call instead", "429 Please wait a minute"]);
    expect((await post(busy, GOOD, { ip: "2001:db8:4:8::1" })).status).toBe(303);
  });

  it("returns 404 for a form that is not this live site's", async () => {
    const other = await seedSite(tools);
    const draft = await seedSite(tools, { live: false });
    const down = await seedSite(tools, { takenDown: true });
    expect((await post({ slug: other.slug, siteId: site.siteId }, GOOD)).status).toBe(404);
    expect((await post(draft, GOOD)).status).toBe(404);
    expect((await post(down, GOOD)).status).toBe(404);
    expect((await post({ slug: site.slug, siteId: newId() }, GOOD)).status).toBe(404);
    expect((await post({ slug: site.slug, siteId: "../../etc" }, GOOD)).status).toBe(404);
    expect(await leads(draft.siteId)).toEqual([]);
  });

  it("never asks D1 about a form for a site with no approved page: with D1's sites table gone it is still 404", async () => {
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      expect((await post({ slug: "no-such-shop", siteId: newId() }, GOOD)).status).toBe(404);
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
  });

  it("answers our 503 page with noindex, never the platform's error page, when D1 fails while storing the lead", async () => {
    const target = await seedSite(tools);
    await tools.DB.prepare("ALTER TABLE leads RENAME TO leads_offline").run();
    try {
      const response = await post(target, GOOD);
      expect(response.status).toBe(503);
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
      expect(await response.text()).toContain("<h1>Temporarily unavailable</h1>");
    } finally {
      await tools.DB.prepare("ALTER TABLE leads_offline RENAME TO leads").run();
    }
    expect(await leads(target.siteId)).toEqual([]);
  });

  it("closes the form for the day after 50 leads, exactly", async () => {
    const popular = await seedSite(tools);
    const now = Date.now();
    await tools.DB.batch(
      Array.from({ length: 50 }, () =>
        tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES (?, ?, ?, 'n', '5125550100', 'sent', 'h')").bind(newId(), popular.siteId, now),
      ),
    );
    const response = await post(popular, GOOD);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("<h1>Please call instead</h1>");
    expect(await leads(popular.siteId)).toHaveLength(50);
    // The site's own cap refused it, not the visitor's network (A15): the log line names which.
    expect(await linesWith(harness, "siteId", popular.siteId, 1)).toEqual([
      { worker: "asksite-sites", route: "form", status: 429, ms: expect.any(Number), siteId: popular.siteId, code: "site_daily_cap" },
    ]);
  });

  it("stores link-heavy messages as spam without emailing the owner", async () => {
    const target = await seedSite(tools);
    const response = await post(target, { ...GOOD, message: "http://a http://b https://c http://d" });
    expect(response.status).toBe(303);
    const [lead] = await leads(target.siteId);
    expect(lead).toMatchObject({ spam: 1, email_status: "skipped" });
    expect(await outboxFor(target.ownerEmail)).toEqual([]);
  });

  it("removes control and invisible characters but keeps the message's line breaks", async () => {
    const target = await seedSite(tools);
    await post(target, { ...GOOD, name: "Da\u202Ena\u0007 P", message: "Line one\r\nLine\u200B two" });
    const [lead] = await leads(target.siteId);
    expect(lead).toMatchObject({ name: "Dana P", message: "Line one\nLine two" });
  });
});

describe("when email fails", () => {
  const broken = sitesHarness({ vars: { MAILER: "resend" } });
  let brokenTools: ToolsEnv;
  beforeAll(async () => {
    ({ tools: brokenTools } = await broken.start());
  }, 120_000);
  afterAll(async () => {
    await broken.server.close();
  });

  it("still saves the lead, marks it failed and thanks the visitor", async () => {
    const site = await seedSite(brokenTools);
    const response = await broken.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.200" },
      body: new URLSearchParams(GOOD).toString(),
    });
    expect(response.status).toBe(303);
    const [lead] = await settledLeads(brokenTools, site.siteId);
    expect(lead).toMatchObject({ email_status: "failed", email_error: "misconfigured" });
  });
});

describe("without IP_HASH_KEY", () => {
  const keyless = sitesHarness({ secrets: { IP_HASH_KEY: "" } });
  let keylessTools: ToolsEnv;
  beforeAll(async () => {
    ({ tools: keylessTools } = await keyless.start());
  }, 120_000);
  afterAll(async () => {
    await keyless.server.close();
  });

  it("fails closed with 503 and stores nothing (it never stores a raw IP)", async () => {
    const site = await seedSite(keylessTools);
    const response = await keyless.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(GOOD).toString(),
    });
    expect(response.status).toBe(503);
    expect(await keylessTools.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toEqual({ n: 0 });
  });
});

// Pins added after the brief (test-only). Each one goes red on a mutant that the tests above let through.
describe("form edges", () => {
  /** Miniflare's rate-limit windows are wall-clock minutes: start a burst early in one so it never spans two. */
  async function earlyInAMinute(): Promise<void> {
    const left = 60_000 - (Date.now() % 60_000);
    if (left < 15_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
  }

  it("keys the rate limit per site: a visitor stopped on one site can still use another site's form", async () => {
    const busy = await seedSite(tools);
    const other = await seedSite(tools);
    await earlyInAMinute();
    const pages: string[] = [];
    for (let i = 0; i < 6; i++) pages.push(await pageOf(await post(busy, GOOD, { ip: "192.0.2.60" })));
    expect(pages).toEqual(["303", "303", "303", "429 Please call instead", "429 Please call instead", "429 Please wait a minute"]);
    expect((await post(other, GOOD, { ip: "192.0.2.60" })).status).toBe(303);
  });

  // A15: the stored hash is the network's, the key the daily network limits count (was the full address).
  it("stores the hash of the visitor's IPv6 /64 network, not of its full address", async () => {
    const target = await seedSite(tools);
    expect((await post(target, GOOD, { ip: "2001:db8:9:1::abcd" })).status).toBe(303);
    const [lead] = await leads(target.siteId);
    expect(lead?.["ip_hash"]).toBe(await hashIp(TEST_SECRETS.IP_HASH_KEY, "2001:db8:9:1::/64"));
    expect(lead?.["ip_hash"]).not.toBe(await hashIp(TEST_SECRETS.IP_HASH_KEY, "2001:db8:9:1::abcd"));
  });

  it("lets D1 decide: a LIVE object for a site D1 does not call live, or under another slug, gets 404 and stores nothing", async () => {
    const draft = await seedSite(tools, { live: false, withObject: true });
    expect((await post(draft, GOOD)).status).toBe(404);
    const moved = await seedSite(tools);
    const oldSlug = `${moved.slug}-old`;
    await putLive(tools, { ...moved, slug: oldSlug });
    expect((await post({ slug: oldSlug, siteId: moved.siteId }, GOOD)).status).toBe(404);
    expect(await leads(draft.siteId)).toEqual([]);
    expect(await leads(moved.siteId)).toEqual([]);
  });

  it("never asks D1 about another id on a live site's host: with D1's sites table gone it is still 404", async () => {
    const live = await seedSite(tools);
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      expect((await post({ slug: live.slug, siteId: newId() }, GOOD)).status).toBe(404);
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
  });

  it("accepts the form content type with parameters and in any letter case", async () => {
    const target = await seedSite(tools);
    const response = await post(target, GOOD, { headers: { "content-type": "Application/X-WWW-Form-URLEncoded; charset=UTF-8" } });
    expect(response.status).toBe(303);
  });

  it("accepts a body of exactly 24 KiB and refuses one byte more", async () => {
    const target = await seedSite(tools);
    const head = new URLSearchParams({ name: "Al", phone: "5125550199", pad: "" }).toString();
    const body = (bytes: number) => head + "a".repeat(bytes - head.length);
    expect((await post(target, {}, { body: body(24 * 1024) })).status).toBe(303);
    expect((await post(target, {}, { body: body(24 * 1024 + 1) })).status).toBe(413);
  });
});

// Pins added after the brief (test-only). Each one goes red on a mutant that every test above lets through.
describe("form edges: the day cap's window and the form address's methods", () => {
  /** The cap counts leads since 00:00 UTC: start well clear of midnight, so the test and the Worker see the same day. */
  async function clearOfMidnight(): Promise<void> {
    const left = 86_400_000 - (Date.now() % 86_400_000);
    if (left < 15_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
  }

  it("counts only today's leads toward the cap: yesterday's do not count, one at 00:00 UTC today does", async () => {
    await clearOfMidnight();
    const popular = await seedSite(tools);
    const now = Date.now();
    const today = now - (now % 86_400_000); // 00:00 UTC, worked out here rather than with the code's own helper
    const lead = (createdAt: number) =>
      tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES (?, ?, ?, 'n', '5125550100', 'sent', 'h')").bind(newId(), popular.siteId, createdAt);
    await tools.DB.batch([...Array.from({ length: 50 }, () => lead(today - 1)), ...Array.from({ length: 49 }, () => lead(today))]);
    expect((await post(popular, GOOD)).status).toBe(303);
    expect((await post(popular, GOOD)).status).toBe(429);
    expect(await leads(popular.siteId)).toHaveLength(100);
  });

  it("answers the form address only to POST: a GET is the 404 page", async () => {
    const target = await seedSite(tools);
    const response = await harness.server.fetch(at(target.slug, `/_f/${target.siteId}`));
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("<h1>Page not found</h1>");
  });
});

// A15: both "Please call instead" refusals print the business phone as a tel: link. approveVersion stores
// it in the LIVE object's metadata, which the handler already reads with LIVE.head (no extra R2 read).
describe("the 'Please call instead' page and the business phone", () => {
  const CALL = '<p>This form cannot take more messages for now.</p>\n<p><a href="tel:+15125550142">Call (512) 555-0142</a></p>';
  const ON_THE_WEBSITE = "<p>This form cannot take more messages for now. The business's phone number is on the website.</p>";

  /** A live site whose day cap other networks have used up. */
  async function fullSite(metadata: Record<string, string>): Promise<SeededSite> {
    const site = await seedSite(tools, { metadata });
    const now = Date.now();
    await tools.DB.batch(
      Array.from({ length: LIMITS.leadsPerSitePerDay }, () =>
        tools.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES (?, ?, ?, 'n', '5125550100', 'sent', ?)").bind(newId(), site.siteId, now, newId()),
      ),
    );
    return site;
  }

  it("prints it as a tel: link when the site's day cap refuses a post", async () => {
    const response = await post(await fullSite(PHONE_METADATA), GOOD);
    expect(response.status).toBe(429);
    const body = await response.text();
    expect(body).toContain(CALL);
    expect(body).not.toContain(ON_THE_WEBSITE);
  });

  it("prints it as a tel: link when the visitor's network has used up its daily limit", async () => {
    const site = await seedSite(tools, { metadata: PHONE_METADATA });
    for (let i = 0; i < LIMITS.leadsPerNetworkPerSitePerDay; i++) expect((await post(site, GOOD, { ip: "192.0.2.70" })).status).toBe(303);
    const response = await post(site, GOOD, { ip: "192.0.2.70" });
    expect(response.status).toBe(429);
    expect(await response.text()).toContain(CALL);
  });

  it("points to the phone number on the website for a page approved before the phone was stored", async () => {
    const body = await (await post(await fullSite({}), GOOD)).text();
    expect(body).toContain(ON_THE_WEBSITE);
    expect(body).not.toContain("tel:");
  });

  it("escapes the phone text", async () => {
    const body = await (await post(await fullSite({ ...PHONE_METADATA, phoneText: '<img src=x onerror="alert(1)">' }), GOOD)).text();
    expect(body).toContain('<a href="tel:+15125550142">Call &lt;img src=x onerror="alert(1)"&gt;</a>');
    expect(body).not.toContain("<img");
  });

  it("prints no link unless the metadata holds a phone text and an E.164 number", async () => {
    const site = await fullSite(PHONE_METADATA);
    const odd = [
      { phoneTel: "+15125550142" },
      { phoneText: "(512) 555-0142" },
      { phoneText: "", phoneTel: "+15125550142" },
      ...["", "5125550142", "+1 512 555 0142", "+05125550142", "+1234567890123456", "javascript:alert(1)", '+15125550142"'].map((phoneTel) => ({ phoneText: "(512) 555-0142", phoneTel })),
    ];
    for (const metadata of odd) {
      await putLive(tools, site, metadata);
      const body = await (await post(site, GOOD)).text();
      expect({ metadata, fallback: body.includes(ON_THE_WEBSITE), link: body.includes("tel:") }).toEqual({ metadata, fallback: true, link: false });
    }
  });
});
