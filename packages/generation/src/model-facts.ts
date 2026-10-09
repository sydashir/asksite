import { serviceAreaScopeOf, type Facts, type ServiceAreaScope, type Trade } from "@asksite/site-schema";

/**
 * The only owner facts the model sees (design §6.1). Phone, email, street, ZIP (including a ZIP
 * given as a service-area place), licence numbers, prices, hours, reviews, photos, social links
 * and the service-area note never leave our servers: the copy may not state them anyway, and the
 * page shows them from facts.
 */
export interface ModelFacts {
  businessName: string;
  trade: Trade;
  /** Only for trade "other": the kind of business the owner named ("Bakery"). It is a business type, not personal data. */
  tradeOther?: string;
  city: string;
  state: string;
  services: string[];
  serviceAreaScope: ServiceAreaScope;
  /** Empty unless the scope is "places": a business serving the whole country or worldwide keeps its places off the page. */
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

/**
 * The most UTF-16 units of each owner string the model sees: each is that string's Facts or Brief cap
 * (test/models.test.ts pins them to the schemas). Zod counts those caps in code points, so text made
 * of characters outside the BMP (such as emoji: 2 units and 4 UTF-8 bytes each) can hold twice as many
 * units; cutting the model's view at the cap keeps every kept unit at most 3 UTF-8 bytes (plan
 * Decision 4). Only the model's view is cut: the stored facts, the owner's brief and the page never
 * change, and only text near its cap that uses such characters loses its end. Service names are not
 * cut: the model copies them and checkDraft binds its copy to the owner's exact name (validate.ts).
 */
export const MODEL_TEXT_CAPS = { businessName: 60, tradeOther: 40, city: 40, place: 40, differentiator: 140, notes: 2000, comment: 500 } as const;

/** The model's view of an owner string: its first `cap` UTF-16 units, well-formed (a cut through a surrogate pair leaves U+FFFD). */
export const modelText = (text: string, cap: number): string => wellFormed(text.slice(0, cap));

/** A place with a digit is a ZIP code or similar; copy cannot use digits anyway. */
const HAS_DIGIT = /\p{N}/u;

export function toModelFacts(facts: Facts): ModelFacts {
  const scope = serviceAreaScopeOf(facts);
  return {
    businessName: modelText(facts.businessName, MODEL_TEXT_CAPS.businessName),
    trade: facts.trade,
    ...(facts.trade === "other" && facts.tradeOther !== undefined ? { tradeOther: modelText(facts.tradeOther, MODEL_TEXT_CAPS.tradeOther) } : {}),
    city: modelText(facts.location.city, MODEL_TEXT_CAPS.city),
    state: facts.location.state,
    // The model copies these into serviceDescriptions; checkDraft binds its copy to the owner's
    // exact name (validate.ts), so they are sent whole, never cut.
    services: facts.services.map((s) => wellFormed(s.name)),
    serviceAreaScope: scope,
    serviceAreaPlaces:
      scope === "places" ? facts.serviceArea.places.filter((place) => !HAS_DIGIT.test(place)).map((place) => modelText(place, MODEL_TEXT_CAPS.place)) : [],
    hasLicence: facts.licences.length > 0,
    insured: facts.insured,
    emergency247: facts.emergency247,
    freeEstimates: facts.freeEstimates,
    hasYearFounded: facts.yearFounded !== undefined,
  };
}
