import { describe, expect, it } from "vitest";
import { Facts } from "../src/facts.ts";

const minimal = {
  businessName: "Mop",
  trade: "cleaning",
  phone: "+15125550142",
  email: "hello@example.com",
  location: { city: "Austin", state: "TX" },
  serviceArea: { places: ["Austin"] },
  services: [{ name: "House cleaning" }],
};

const issuePaths = (input: unknown) => {
  const result = Facts.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};

describe("Facts", () => {
  it("parses a minimal owner entry and fills defaults", () => {
    const facts = Facts.parse(minimal);
    expect(facts.hours).toEqual([]);
    expect(facts.licences).toEqual([]);
    expect(facts.testimonials).toEqual([]);
    expect(facts.photos).toEqual([]);
    expect(facts.socialLinks).toEqual([]);
    expect(facts.insured).toBe(false);
    expect(facts.emergency247).toBe(false);
    expect(facts.freeEstimates).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(issuePaths({ ...minimal, heroHeadline: "Hi" })).toEqual([""]);
  });

  it.each(["512-555-0142", "+1512555014", "+15121550142", "+44 20 7946 0958"])("rejects phone %j", (phone) => {
    expect(issuePaths({ ...minimal, phone })).toEqual(["phone"]);
  });

  it("enforces business name length 2..60", () => {
    expect(issuePaths({ ...minimal, businessName: "A" })).toEqual(["businessName"]);
    expect(issuePaths({ ...minimal, businessName: "A".repeat(61) })).toEqual(["businessName"]);
    expect(issuePaths({ ...minimal, businessName: "A".repeat(60) })).toEqual([]);
  });

  it("rejects hidden control and formatting characters but keeps emoji", () => {
    expect(issuePaths({ ...minimal, businessName: "Mop‮etis lacigol" })).toEqual(["businessName"]);
    expect(issuePaths({ ...minimal, serviceArea: { places: ["Aus​tin"] } })).toEqual(["serviceArea.places.0"]);
    const emoji = { quote: "Great job \u{1F44D}\u{1F3FD} \u{1F468}‍\u{1F527}", name: "Ana" };
    expect(issuePaths({ ...minimal, testimonials: [emoji] })).toEqual([]);
  });

  it("requires 1..12 services with names up to 40 chars", () => {
    expect(issuePaths({ ...minimal, services: [] })).toEqual(["services"]);
    expect(issuePaths({ ...minimal, services: Array(13).fill({ name: "Drains" }) })).toEqual(["services"]);
    expect(issuePaths({ ...minimal, services: [{ name: "x".repeat(41) }] })).toEqual(["services.0.name"]);
    expect(issuePaths({ ...minimal, services: [{ name: "Drains", startingPrice: 89.5 }] })).toEqual([
      "services.0.startingPrice",
    ]);
  });

  it("only accepts https photo URLs without credentials", () => {
    const photo = { alt: "Van", width: 800, height: 600 };
    expect(issuePaths({ ...minimal, photos: [{ ...photo, url: "http://example.com/a.jpg" }] })).toEqual(["photos.0.url"]);
    expect(issuePaths({ ...minimal, photos: [{ ...photo, url: "javascript:alert(1)" }] })).toEqual(["photos.0.url"]);
    expect(issuePaths({ ...minimal, photos: [{ ...photo, url: "https://user:pw@example.com/a.jpg" }] })).toEqual([
      "photos.0.url",
    ]);
    expect(issuePaths({ ...minimal, photos: [{ ...photo, url: "https://example.com/a.jpg" }] })).toEqual([]);
  });

  it("only accepts https social links", () => {
    expect(issuePaths({ ...minimal, socialLinks: [{ network: "yelp", url: "data:text/html,x" }] })).toEqual([
      "socialLinks.0.url",
    ]);
  });

  it("only accepts a social link on that network's own site", () => {
    const link = (network: string, url: string) => issuePaths({ ...minimal, socialLinks: [{ network, url }] });
    expect(link("facebook", "https://www.facebook.com/mopcleaning")).toEqual([]);
    expect(link("google", "https://maps.app.goo.gl/abc123")).toEqual([]);
    expect(link("facebook", "https://www.facebook.com@evil.example/login")).toEqual(["socialLinks.0.url"]);
    expect(link("facebook", "https://evil.example/facebook.com")).toEqual(["socialLinks.0.url"]);
    expect(link("facebook", "https://notfacebook.com/mop")).toEqual(["socialLinks.0.url"]);
    expect(link("yelp", "https://www.facebook.com/mop")).toEqual(["socialLinks.0.url"]);
  });

  it("refuses an https URL without // after the scheme, which a page would resolve against its own address (A9)", () => {
    const link = (url: string) => issuePaths({ ...minimal, socialLinks: [{ network: "facebook", url }] });
    expect(link("https:facebook.com/mop")).toEqual(["socialLinks.0.url"]);
    expect(link("https:/www.facebook.com/mop")).toEqual(["socialLinks.0.url"]);
    const photo = { alt: "Van", width: 800, height: 600, url: "https:img.example/a.jpg" };
    expect(issuePaths({ ...minimal, photos: [photo] })).toEqual(["photos.0.url"]);
  });

  it("bounds the founding year without reading the clock", () => {
    expect(issuePaths({ ...minimal, yearFounded: 1850 })).toEqual([]);
    expect(issuePaths({ ...minimal, yearFounded: 2100 })).toEqual([]);
    expect(issuePaths({ ...minimal, yearFounded: 1849 })).toEqual(["yearFounded"]);
    expect(issuePaths({ ...minimal, yearFounded: 2101 })).toEqual(["yearFounded"]);
  });

  it("validates opening hours", () => {
    const h = (days: string[], opens: string, closes: string) => ({ ...minimal, hours: [{ days, opens, closes }] });
    expect(issuePaths(h(["Monday"], "08:00", "17:00"))).toEqual([]);
    expect(issuePaths(h(["Monday"], "17:00", "08:00"))).toEqual(["hours.0.closes"]);
    expect(issuePaths(h(["Monday"], "07:5", "17:00"))).toEqual(["hours.0.opens"]);
    expect(issuePaths(h(["Funday"], "08:00", "17:00"))).toEqual(["hours.0.days.0"]);
    expect(
      issuePaths({
        ...minimal,
        hours: [
          { days: ["Monday", "Tuesday"], opens: "08:00", closes: "17:00" },
          { days: ["Tuesday"], opens: "09:00", closes: "12:00" },
        ],
      }),
    ).toEqual(["hours"]);
  });

  it("caps testimonial quotes at 320 characters", () => {
    const t = (quote: string) => ({ ...minimal, testimonials: [{ quote, name: "Ana" }] });
    expect(issuePaths(t("q".repeat(320)))).toEqual([]);
    expect(issuePaths(t("q".repeat(321)))).toEqual(["testimonials.0.quote"]);
  });

  it("validates state and ZIP formats", () => {
    expect(issuePaths({ ...minimal, location: { city: "Austin", state: "Texas" } })).toEqual(["location.state"]);
    expect(issuePaths({ ...minimal, location: { city: "Austin", state: "TX", postalCode: "7870" } })).toEqual([
      "location.postalCode",
    ]);
  });
});
