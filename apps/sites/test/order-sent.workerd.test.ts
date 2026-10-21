import { newId } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { deriveOrderCookieKey, signOrderCookie } from "../src/order-cookie.ts";
import { handleSent } from "../src/order-sent.ts";
import { at, seedSite, sitesHarness, TEST_SECRETS, type SeededSite, type ToolsEnv } from "./support/harness.ts";

// GET /_o/<siteId>/sent/<orderId> (pages lane proposal 1.6 step 10; review I4; strict tier: customer data). The page
// shows the order's number, lines, subtotal and fulfilment only to the browser holding the signed order cookie for exactly
// that site and order, checked BEFORE any D1 read; everyone else gets the generic "Order received" naming the business.
// It never shows the buyer's name, email, phone or address. SHOP_GET_RL bounds even a valid cookie's reads.

const h = sitesHarness();
let sites: Env;
let tools: ToolsEnv;
beforeAll(async () => {
  ({ sites, tools } = await h.start());
}, 120_000);
afterAll(async () => {
  await h.server.close();
});

const NOW = Date.now();
const LINES = [
  { productId: newId(), variantId: null, slug: "mom-flipflop", name: "Mom Flipflop", variantLabel: null, unitCents: 5000, compareAtCents: null, qty: 2, maxQty: 10, lineCents: 10000 },
  { productId: newId(), variantId: newId(), slug: "sandal", name: "Sandal", variantLabel: "Large", unitCents: 2499, compareAtCents: null, qty: 1, maxQty: 10, lineCents: 2499 },
];

async function shopWithOrder(): Promise<{ site: SeededSite; orderId: string }> {
  const site = await seedSite(tools, { metadata: { businessName: "Hip Hop Flip Flopp" } });
  const orderId = newId();
  await tools.DB.prepare(
    `INSERT INTO orders (id, site_id, number, version_id, created_at, name, phone, email, fulfilment, address_json, items_json, subtotal_cents, cart_id, cart_hash, email_status, ip_hash, net_hash)
     VALUES (?, ?, 1001, ?, ?, 'Zelda Quux', '+17375550111', 'zelda@example.com', 'delivery', '{"line1":"77 Secret Rd","city":"Austin","state":"TX","zip":"78701"}', ?, 12499, ?, 'h', 'sent', 'i', 'n')`,
  ).bind(orderId, site.siteId, site.versionId, NOW, JSON.stringify(LINES), newId()).run();
  return { site, orderId };
}

async function cookieFor(siteId: string, orderId: string, expiresAt = NOW + 86_400_000): Promise<string> {
  return `order=${await signOrderCookie((await deriveOrderCookieKey(TEST_SECRETS.IP_HASH_KEY))!, { siteId, orderId, expiresAt })}`;
}

let ip = 0;
function get(site: SeededSite, orderId: string, cookie: string | null, env: Env = sites, from?: string) {
  ip += 1;
  const headers: Record<string, string> = { "cf-connecting-ip": from ?? `192.0.2.${ip % 250}` };
  if (cookie !== null) headers["cookie"] = cookie;
  const request = new Request(at(site.slug, `/_o/${site.siteId}/sent/${orderId}`), { headers });
  return handleSent(request, env, { slug: site.slug, siteId: site.siteId, orderId, now: NOW });
}

const noD1 = () => ({ ...pick(sites), DB: new Proxy({}, { get: () => { throw new Error("D1 touched"); } }) }) as unknown as Env;

describe("handleSent", () => {
  it("shows the order's number, lines, subtotal and fulfilment to the browser holding its signed cookie", async () => {
    const { site, orderId } = await shopWithOrder();
    expect(await get(site, orderId, await cookieFor(site.siteId, orderId))).toEqual({
      kind: "sent",
      slot: {
        businessName: "Hip Hop Flip Flopp",
        order: { number: 1001, subtotalCents: 12499, fulfilment: "delivery", lines: [
          { name: "Mom Flipflop", qty: 2, lineCents: 10000 },
          { name: "Sandal", variantLabel: "Large", qty: 1, lineCents: 2499 },
        ] },
      },
    });
  });

  it("never carries the buyer's name, email, phone or address", async () => {
    const { site, orderId } = await shopWithOrder();
    const shown = JSON.stringify(await get(site, orderId, await cookieFor(site.siteId, orderId)));
    for (const value of ["Zelda", "Quux", "zelda@", "7375550111", "Secret Rd"]) expect(shown).not.toContain(value);
  });

  it("gives everyone else the generic page, without reading D1: no cookie, another order's, another site's, expired, tampered", async () => {
    const { site, orderId } = await shopWithOrder();
    const generic = { kind: "sent", slot: { businessName: "Hip Hop Flip Flopp" } };
    const valid = await cookieFor(site.siteId, orderId);
    for (const cookie of [
      null,
      await cookieFor(site.siteId, newId()),
      await cookieFor(newId(), orderId),
      await cookieFor(site.siteId, orderId, NOW - 1),
      valid.slice(0, -2) + (valid.endsWith("AA") ? "BB" : "AA"),
      "order=garbage",
    ]) {
      expect(await get(site, orderId, cookie, noD1())).toEqual(generic);
    }
  });

  it("answers 404 for a malformed id, or a host whose pointer names another site or none", async () => {
    const { site, orderId } = await shopWithOrder();
    const other = await seedSite(tools);
    expect(await handleSent(new Request(at(site.slug, "/x")), noD1(), { slug: site.slug, siteId: "nope", orderId, now: NOW })).toEqual({ kind: "fixed", page: "not_found", code: "bad_id" });
    expect(await handleSent(new Request(at(other.slug, "/x")), noD1(), { slug: other.slug, siteId: site.siteId, orderId, now: NOW })).toMatchObject({ kind: "fixed", page: "not_found" });
  });

  it("bounds even a valid cookie's D1 reads (SHOP_GET_RL: 30 a minute): past it the generic page, no D1", async () => {
    const { site, orderId } = await shopWithOrder();
    const cookie = await cookieFor(site.siteId, orderId);
    const kinds: boolean[] = [];
    for (let i = 0; i < 40; i++) kinds.push("order" in ((await get(site, orderId, cookie, sites, "198.51.100.200")) as { slot: object }).slot);
    expect(kinds.filter((shown) => !shown).length).toBeGreaterThan(0);
  });
});

function pick(env: Env): Record<string, unknown> {
  const names = ["DB", "LIVE", "MEDIA", "FORM_RL", "ORDER_RL", "SHOP_GET_RL", "ENVIRONMENT", "ROOT_DOMAIN", "MAILER", "MAIL_FROM", "SECURITY_TXT_EXPIRES", "LEAD_EMAILS_PER_DAY", "ORDER_EMAILS_PER_DAY", "RESEND_API_KEY", "IP_HASH_KEY"] as const;
  return Object.fromEntries(names.map((n) => [n, env[n]]));
}
