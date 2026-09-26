import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { at, seedSite, settledLeads, sitesHarness, type ToolsEnv } from "./support/harness.ts";

// The real Resend mailer running inside workerd. The harness sends the Worker's outbound fetch
// through this Node process's global fetch, so the test answers for api.resend.com and fails on
// any other host: nothing ever leaves the machine.
const harness = sitesHarness({ vars: { MAILER: "resend", MAIL_FROM: "asksite <leads@mail.asksite.example>" }, secrets: { RESEND_API_KEY: "re_test_not_a_real_key" } });
let tools: ToolsEnv;
const realFetch = globalThis.fetch;
const outbound: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
let resendStatus = 200;

beforeAll(async () => {
  ({ tools } = await harness.start());
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).host !== "api.resend.com") throw new Error(`Unexpected outbound request to ${request.url}`);
    outbound.push({ url: request.url, headers: Object.fromEntries(request.headers), body: await request.json() });
    return Response.json(resendStatus === 200 ? { id: "email-id-1" } : { message: "limit" }, { status: resendStatus });
  }) as typeof fetch;
}, 120_000);
afterEach(() => {
  outbound.length = 0;
  resendStatus = 200;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await harness.server.close();
});

const GOOD = { name: "Dana <b>Price</b>", phone: "512 555 0199", email: "dana@example.com", message: "Hi" };
const post = (site: { slug: string; siteId: string }) =>
  harness.server.fetch(at(site.slug, `/_f/${site.siteId}`), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.77" },
    body: new URLSearchParams(GOOD).toString(),
  });

describe("lead email through Resend (inside workerd)", () => {
  it("sends one documented request with an idempotency key and marks the lead sent", async () => {
    const site = await seedSite(tools);
    expect((await post(site)).status).toBe(303);
    const [lead] = await settledLeads(tools, site.siteId);
    expect(lead?.["email_status"]).toBe("sent");
    expect(outbound).toHaveLength(1);
    const [call] = outbound;
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect(call?.headers).toMatchObject({ authorization: "Bearer re_test_not_a_real_key", "idempotency-key": `lead:${String(lead?.["id"])}`, "content-type": "application/json" });
    expect(call?.body).toMatchObject({
      from: "asksite <leads@mail.asksite.example>",
      to: [site.ownerEmail],
      subject: "New request from your website: Dana <b>Price</b>",
      reply_to: "dana@example.com",
    });
    const html = (call?.body as { html: string }).html;
    expect(html).toContain("<strong>Name:</strong> Dana &lt;b&gt;Price&lt;/b&gt;");
    expect(html).not.toContain("<b>Price</b>");
  });

  it("marks the lead failed with the Resend error code when Resend refuses", async () => {
    resendStatus = 429;
    const site = await seedSite(tools);
    expect((await post(site)).status).toBe(303);
    const [lead] = await settledLeads(tools, site.siteId);
    expect(lead).toMatchObject({ email_status: "failed", email_error: "rate_limited" });
  });
});

// Pin added after the brief (test-only): with the email awaited before the 303, the tests above still pass.
describe("the lead email runs after the response (Decision 26)", () => {
  it("thanks the visitor while Resend has not answered, with the lead saved as pending, then marks it sent", async () => {
    const answer = globalThis.fetch;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tooLong = new Promise<"no answer within 10 s">((resolve) => {
      timer = setTimeout(() => resolve("no answer within 10 s"), 10_000);
    });
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      await held;
      return answer(input, init);
    }) as typeof fetch;
    try {
      const site = await seedSite(tools);
      const response = await Promise.race([post(site), tooLong]);
      expect(typeof response === "string" ? response : response.status).toBe(303);
      const pending = await tools.DB.prepare("SELECT email_status FROM leads WHERE site_id = ?").bind(site.siteId).all<Record<string, unknown>>();
      expect(pending.results).toEqual([{ email_status: "pending" }]);
      release();
      const [lead] = await settledLeads(tools, site.siteId);
      expect(lead?.["email_status"]).toBe("sent");
      expect(outbound).toHaveLength(1);
    } finally {
      release();
      clearTimeout(timer);
      globalThis.fetch = answer;
    }
  });
});
