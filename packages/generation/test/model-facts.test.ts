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

  it("replaces lone surrogates with U+FFFD in every owner string, service names included", () => {
    const facts = { ...MINIMAL_FACTS, businessName: "Mop \uD800 Co", services: [{ name: "Tile \uDC00 care" }], serviceArea: { places: ["Aus\uD800tin"] } };
    const sent = toModelFacts(facts);
    expect([sent.businessName, sent.services[0], sent.serviceAreaPlaces[0]]).toEqual(["Mop � Co", "Tile � care", "Aus�tin"]);
  });
});
