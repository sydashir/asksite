import { Facts } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { toModelFacts } from "../src/model-facts.ts";
import { FULL_FACTS, MINIMAL_FACTS } from "./support/samples.ts";

describe("toModelFacts", () => {
  it("sends only the business name, trade, place, service names, service-area places and yes/no flags", () => {
    expect(toModelFacts(FULL_FACTS)).toEqual({
      businessName: "Reliable Rooter",
      trade: "plumbing",
      city: "Austin",
      state: "TX",
      services: ["Drain cleaning", "Leak repair"],
      serviceAreaScope: "places",
      serviceAreaPlaces: ["Austin", "Round Rock"],
      hasLicence: true,
      insured: true,
      emergency247: true,
      freeEstimates: true,
      hasYearFounded: true,
    });
  });

  it("never sends phone, email, street, ZIP, licence numbers, prices, hours, reviews, photos, links or the area note", () => {
    const sent = JSON.stringify(toModelFacts(FULL_FACTS));
    for (const secret of ["5125550142", "office@", "Congress", "78701", "78704", "M-40123", "89", "08:00", "burst pipe", "Dana", "media.example.com", "facebook", "Within 25 miles", "1998"])
      expect(sent).not.toContain(secret);
  });

  it("leaves out service-area places that hold a digit (ZIP codes)", () => {
    const facts = { ...MINIMAL_FACTS, serviceArea: { places: ["78701", "Austin", "Zone 3"] } };
    expect(toModelFacts(facts).serviceAreaPlaces).toEqual(["Austin"]);
  });

  it("reports missing facts as false", () => {
    const sent = toModelFacts(MINIMAL_FACTS);
    expect([sent.hasLicence, sent.insured, sent.emergency247, sent.freeEstimates, sent.hasYearFounded]).toEqual([false, false, false, false, false]);
  });

  it("replaces lone surrogates with U+FFFD in every owner string, city and service names included", () => {
    const facts = {
      ...MINIMAL_FACTS,
      businessName: "Mop \uD800 Co",
      location: { ...MINIMAL_FACTS.location, city: "El \uDC00 Paso" },
      services: [{ name: "Tile \uDC00 care" }],
      serviceArea: { places: ["Aus\uD800tin"] },
    };
    const sent = toModelFacts(facts);
    expect([sent.businessName, sent.city, sent.services[0], sent.serviceAreaPlaces[0]]).toEqual(["Mop � Co", "El � Paso", "Tile � care", "Aus�tin"]);
  });

  it("cuts businessName, city and each place to their cap in UTF-16 units for the model only; service names stay whole", () => {
    const smile = "\u{1F600}";
    // Each at its schema cap in code points (60, 40, 40, 40), so twice as many UTF-16 units. The second place is
    // 40 code points but 79 units, so the cut at 40 units splits its last surrogate pair, which becomes U+FFFD.
    const facts = Facts.parse({
      ...MINIMAL_FACTS,
      businessName: smile.repeat(60),
      location: { ...MINIMAL_FACTS.location, city: smile.repeat(40) },
      serviceArea: { places: [smile.repeat(40), `a${smile.repeat(39)}`] },
      services: [{ name: smile.repeat(40) }],
    });
    const before = structuredClone(facts);
    const sent = toModelFacts(facts);
    expect([sent.businessName, sent.city, sent.serviceAreaPlaces, sent.services]).toEqual([
      smile.repeat(30),
      smile.repeat(20),
      [smile.repeat(20), `a${smile.repeat(19)}\uFFFD`],
      [smile.repeat(40)],
    ]);
    expect(facts).toEqual(before);
  });

  it("sends the scope, no places unless it is places, and the owner's own business type only for trade other", () => {
    const sent = (extra: object) => toModelFacts(Facts.parse({ ...FULL_FACTS, ...extra }));
    expect([sent({ serviceAreaScope: "country" }), sent({ serviceAreaScope: "worldwide" })].map((f) => [f.serviceAreaScope, f.serviceAreaPlaces])).toEqual([
      ["country", []],
      ["worldwide", []],
    ]);
    expect(sent({ trade: "other", tradeOther: "Bakery" }).tradeOther).toBe("Bakery");
    expect("tradeOther" in sent({ trade: "law" })).toBe(false);
  });
});
