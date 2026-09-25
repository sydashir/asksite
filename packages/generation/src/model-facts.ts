import type { Facts, Trade } from "@asksite/site-schema";

/**
 * The only owner facts the model sees (design §6.1). Phone, email, street, ZIP (including a ZIP
 * given as a service-area place), licence numbers, prices, hours, reviews, photos, social links
 * and the service-area note never leave our servers: the copy may not state them anyway, and the
 * page shows them from facts.
 */
export interface ModelFacts {
  businessName: string;
  trade: Trade;
  city: string;
  state: string;
  services: string[];
  serviceAreaPlaces: string[];
  hasLicence: boolean;
  insured: boolean;
  emergency247: boolean;
  freeEstimates: boolean;
  hasYearFounded: boolean;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Owner text with any lone UTF-16 surrogate replaced by U+FFFD, so it encodes as valid UTF-8. */
export const wellFormed = (text: string): string => text.replace(LONE_SURROGATE, "�");

/** A place with a digit is a ZIP code or similar; copy cannot use digits anyway. */
const HAS_DIGIT = /\p{N}/u;

export function toModelFacts(facts: Facts): ModelFacts {
  return {
    businessName: wellFormed(facts.businessName),
    trade: facts.trade,
    city: wellFormed(facts.location.city),
    state: facts.location.state,
    // The model copies these into serviceDescriptions; checkDraft binds its copy to the owner's
    // exact name (validate.ts), so they need no special treatment here.
    services: facts.services.map((s) => wellFormed(s.name)),
    serviceAreaPlaces: facts.serviceArea.places.filter((place) => !HAS_DIGIT.test(place)).map(wellFormed),
    hasLicence: facts.licences.length > 0,
    insured: facts.insured,
    emergency247: facts.emergency247,
    freeEstimates: facts.freeEstimates,
    hasYearFounded: facts.yearFounded !== undefined,
  };
}
