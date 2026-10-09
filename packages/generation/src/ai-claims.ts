import type { Issue } from "@asksite/core";
import { NEEDS_A_FACT, proseIn, readings, serviceAreaScopeOf, type Copy, type Facts } from "@asksite/site-schema";

// Claims the model must not make in its copy. These rules are AI-only: aiClaims runs in checkDraft (at generation) and in
// aiCopyIssues (exported for Plan 4, which re-checks stored AI copy against today's facts when it composes a page, so a stored
// AI draft can start failing a fact that was turned off, or a rule added after it was made). Owner text is never held to them:
// aiCopyIssues skips the fields the owner edited, and render() does not check them. The owner may write "lic." or "free
// of charge" on their own site; only what the model writes is held to the stricter list, because the model has no facts it can point to. A refusal goes back to
// the model as a repair issue (generate.ts); if every attempt is refused, the generation ends without that answer. The
// owner never sees these refusals. site-schema's checker (claims.ts) is unchanged and runs first.
//
// Each text is matched as claims.ts reads it: as typed, then folded (look-alike letters), every dash read by
// asReadOnPage, with each of those again reading "_" and the glued symbol separators as a space (claims.ts's readings(),
// shared by both checkers, which also joins runs of single letters: "F R E E" reads "FREE"), and the words of a multi-word claim joined by a hyphen, a space or a dash character. A claim any reading finds counts.
// Word lists, not every paraphrase: the owner still approves every page.

/** The joiner between the words of a multi-word claim: hyphen, space, figure dash, en dash, em dash or minus sign (as claims.ts). */
const J = "[-\\u2012\\u2013\\u2014\\u2212 ]";

const NEVER_IN_AI_COPY: readonly RegExp[] = [
  new RegExp(`\\bwithin${J}(the|an?|one)${J}hour\\b`, "i"), // a response time no fact backs
  // The same claim after an arrival phrase and "in" ("Here in under an hour", "Onsite in under one hour", "At your door in less than an
  // hour"). "takes under an hour", "done in under an hour" and "On site under an hour" (no "in") are a job's length, usual in trade
  // copy, so the arrival phrase and "in" must both be there. Known false positives, the model can rephrase them (one repair turn; the
  // owner never sees them): "in and out of there in under an hour", and a place word, "in" and a duration ("done onsite in under an
  // hour"). The written residuals: other response-time paraphrases ("we get
  // to you fast", "a quick hour away", "within the next hour", "within half an hour") are accepted; the prompt's "Invent nothing:
  // ... response times" is the backstop.
  new RegExp(`\\b(here|there|arrive[sd]?|arriving|on${J}?site|at${J}your${J}door|out${J}to${J}you)${J}in${J}(under|less${J}than)${J}(an|one)${J}hour\\b`, "i"),
  new RegExp(`\\b(state|board|city|county)${J}approved\\b`, "i"), // a licence paraphrase
  new RegExp(`\\bbackground${J}check(s|ed|ing)?\\b`, "i"),
  // "vet" alone is no claim ("vet-owned", "pet vet"), so only "vetted", "vetting" and a "vet" before one of the listed determiners
  // ("vets all", "vet our") count. Known false positives, rephrasable: "vet our work", "vets" meaning veterans. Residual: "vet everyone",
  // "vet them".
  new RegExp(`\\b(vetted|vetting|vets?${J}(every|each|all|our|its|their))\\b`, "i"),
  // Time in business comes from yearFounded. "long time" with a space is usually no claim ("lasts a long time"), so only
  // the closed and dashed forms count; the written residual: every space form (any whitespace run) is accepted, e.g.
  // "a long time local business", "serving Austin for a long time".
  /\b(long[-\u2012\u2013\u2014\u2212]?time|seasoned)\b/i,
  /\b(raves?|raved|raving|recommended)\b/i, // "we recommend" is advice and stays allowed
  // "recommend annual service" and "recommend using" stay allowed. Known false positives: "recommend U.S.-made" (the spelled-run reading
  // joins "U.S." to "US") and the referral line "Thanks for recommending us".
  new RegExp(`\\brecommend(s|ing)?${J}us\\b`, "i"),
  /[\u2039\u203A\u301D-\u301F\uFF02]/, // quote marks claims.ts does not list
  // A phrase in straight single quotes: an opening ' at a word start (at the start of the text or after a space, a
  // colon, a semicolon, a comma, a dash or one of the eight separator symbols · • ~ * | ∙ ・ ●, glued or not, or after a "(" that itself follows one of those; not after a letter or a
  // second "(": code such as f('x') quotes nobody, and the XSS fixture holds some) before a letter, closed
  // by a ' not before a letter. An apostrophe inside a word ("don't", "owner's") never opens or closes, and neither
  // does one that starts an elision, in any case: 'n' (rock 'n' roll), 'em, 'til, 'cause, 'bout, 'round, 'tis, 'twas.
  // The symbols are in the class itself because readings() reads one apart only when it is glued between two non-space
  // characters: "Our*'Tidy'*crew" is read apart, but "*'Tidy'* crew" and "Our motto |'clean homes'" are not.
  // The written residual: a real quotation that starts with one of these elision words is accepted ("'Tis the best crew
  // ever' Dana"); it cannot be told apart from the allowed "'Tis the season, 'twas the owners' idea".
  /(?<=(?:^|[\s:;,·•~*|∙・●\u2012-\u2014\u2212-])\(?)'(?!n'|(?:em|til|cause|bout|round|tis|twas)(?!\p{L}))\p{L}(?:[^']|'(?=\p{L}))*'(?!\p{L})/iu,
];

/** "and" between joiners, or "&" with an optional joiner each side ("lic&ins"). */
const AND = `(?:${J}and${J}|${J}?&${J}?)`;
/** The words before a country or the world in a service-area phrase: "around the country", "everywhere in the world". */
const AREA = `(around|across|all${J}over|throughout|anywhere${J}in|everywhere${J}in)`;
/** A country, as the service-area rules name it: "US" only after a determiner ("across us" is the pronoun). */
const COUNTRY = `(country|nation|united${J}states|usa?)`;
/** The world, as the service-area rules name it. */
const WORLD = `(world|globe|planet)`;

/** What follows "lic" in "lic and ins" / "lic & ins": AND, then "ins" (a dot after "ins" is the caller's). */
const LIC_AND_INS = `${AND}ins\\b`;

/**
 * claims.ts's own backing for its seven-days rule (24/7 service, or opening hours on all seven days), taken from NEEDS_A_FACT.
 * Shared: the every-day words below are checked with it, and prompt.ts computes its "every day" entry from it. The after-hours
 * and holiday words are not: only 24/7 service backs them.
 */
const sevenDaysRule = NEEDS_A_FACT.find(({ pattern }) => pattern.test("seven days a week"));
if (sevenDaysRule === undefined) throw new Error("claims.ts lost its seven-days rule");
export const sevenDaysBacking: (facts: Facts) => boolean = sevenDaysRule.backedBy;

/** Wording allowed only when the owner's facts back it. */
const NEEDS_A_FACT_IN_AI_COPY: ReadonlyArray<{ readonly pattern: RegExp; readonly backedBy: (facts: Facts) => boolean }> = [
  { pattern: /\blic\./i, backedBy: (facts) => facts.licences.length > 0 },
  // "ins." counts on its own, not after an ASCII letter or after an ASCII letter and a hyphen ("check-ins.", "walk-ins."); "lic.-ins." counts.
  // Only ASCII letters: other letters (U+A78F, U+02D0, U+0640) can draw as punctuation, so "Fully\uA78Fins." still counts.
  // The written residual: a word, a hyphen, then "ins." is accepted by this rule ("Fully-ins."), the shape of "walk-ins.";
  // "Licensed-and-ins." is refused by the mixed-pair rule below.
  // Not "coverage" or "covered": they describe the service area.
  { pattern: /(?<![a-z]-?)\bins\.|\bliabilit(?:y|ies)/iu, backedBy: (facts) => facts.insured },
  // "lic and ins" / "lic & ins" with a dot dropped from either "lic" or "ins": it states both, so it needs both facts. Only the pair
  // counts ("the ins and outs of drains" stays allowed). The pattern skips "lic. and ins.", which the two rules above already
  // refuse by name, so their words are not listed twice. The one exception: "ins." after a word and a hyphen ("lic.-and-ins.") is no
  // "ins." to the rule above, so the pair refuses it.
  {
    pattern: new RegExp(`\\blic(?:(?!\\.)${LIC_AND_INS}\\.?|\\.${LIC_AND_INS}(?:(?!\\.)|(?<=[a-z]-ins)\\.))`, "i"),
    backedBy: (facts) => facts.licences.length > 0 && facts.insured,
  },
  // The mixed pairs "lic and insured" and "licensed & ins": one side a full word, the other an abbreviation without its dot, which no
  // rule above refuses on its own. Both facts are needed. So is "Licensed-and-ins.": "ins." after a word and a hyphen is no "ins." to
  // the rule above, so this rule refuses it. The other dotted forms are refused elsewhere: "Licensed & ins." by the "ins." rule above,
  // "lic. & insured" by the "lic." rule above and claims.ts's insured rule. The full words "licensed and insured" are the claim
  // checker's. Residuals: "lic" or "ins" alone, "lic/ins", "lic + ins", and the other spellings "Licenced & ins", "License & ins".
  {
    pattern: new RegExp(`\\b(?:lic${AND}insured\\b|licensed${AND}ins\\b(?:(?!\\.)|(?<=[a-z]-ins)\\.))`, "i"),
    backedBy: (facts) => facts.licences.length > 0 && facts.insured,
  },
  // The every-day words: 24/7 service or opening hours on all seven days back them (claims.ts's seven-days backing).
  // Residuals, accepted: "Open each day", "Open all week", "Open seven days".
  {
    pattern: new RegExp(`\\b(every${J}(single${J})?day|(open|available)${J}(daily|everyday))\\b`, "i"), // "daily" and "everyday" alone are not claims ("everyday chores")
    backedBy: sevenDaysBacking,
  },
  // The after-hours and holiday words say service outside the working day, which opening hours on every day do not show (daily 9-5 is
  // not "after hours" or "all hours"), so only 24/7 service backs them. Known false positive, rephrasable: "(every|any) holiday" before a
  // noun ("every holiday season"). Residuals, accepted: "after-hour", "afterhour", "every single holiday", "each holiday", "Late-night
  // service", "Open on Christmas", "After-hour help".
  {
    pattern: new RegExp(`\\b(after${J}?hours|all${J}hours|nights${J}and${J}holidays|holidays|(every|any)${J}holiday)\\b`, "i"), // "holiday" alone is a service ("holiday lights")
    backedBy: (facts) => facts.emergency247,
  },
  // "free" in any form, a hyphenated compound too ("stress-free"), but not inside a longer word ("freedom", "FreeFlow").
  { pattern: /(?<!\p{L})free(?!\p{L})/iu, backedBy: (facts) => facts.freeEstimates },
  // claims.ts has "no charge" and "no cost" (owner rule); their plurals are AI-only. Known false positives, rephrasable: "never charges"
  // of a car or a battery, "charging ahead", "zero charge" of a battery or a card, and "no costs" or "no charges" before a qualifier
  // ("No costs hidden in the fine print"). Residuals: "freebee", "freeby".
  {
    pattern: new RegExp(`\\b(zero${J}(costs?|fees?|charges?)|freebies?|gratis|on${J}the${J}house|never${J}charg(e[ds]?|ing)|without${J}charge|no${J}fees?|no${J}(charge|cost)s)\\b`, "i"),
    backedBy: (facts) => facts.freeEstimates,
  },
  // Where the business serves (2026-10-09, STRICT): the nationwide words only with the scope "country", the worldwide words only with
  // "worldwide"; neither scope backs the other's words. "US" counts only after a determiner ("across us" is the pronoun). Known false
  // positives, rephrasable: a place or a name that holds one of the words ("International Falls", "Global Plumbing"), and "global"
  // in its other senses ("global settings"). Residuals, accepted: "all fifty states" (refused anyway as a spelled number), "statewide",
  // "across America", "far and wide", "abroad", and an AREA word with another determiner ("across a whole country").
  {
    pattern: new RegExp(
      `\\b(nation${J}?wide|country${J}?wide|nationally|coast${J}to${J}coast|${AREA}${J}(the|this|our)${J}((whole|entire)${J})?${COUNTRY}|the${J}(whole|entire)${J}${COUNTRY})\\b`,
      "i",
    ),
    backedBy: (facts) => serviceAreaScopeOf(facts) === "country",
  },
  {
    pattern: new RegExp(
      `\\b(world${J}?wide|${AREA}${J}(the|our)${J}((whole|entire)${J})?${WORLD}|the${J}(whole|entire)${J}${WORLD}|global(ly)?|(multi|inter)national(ly)?|overseas)\\b`,
      "i",
    ),
    backedBy: (facts) => serviceAreaScopeOf(facts) === "worldwide",
  },
];

/**
 * Wording a law firm's copy never uses, whatever the facts (2026-10-09, STRICT): a promise or prediction of an outcome, and a
 * superlative or unchecked comparison. Trade "law" is held to these, and so is trade "other" whose own business type names a legal
 * business (LEGAL_BUSINESS; ruled 2026-10-09). Known false positives, rephrasable: "win" or "result" in another sense ("a win-win",
 * "the result of a claim"). Allowed on purpose: "won't", "as a result" (singular only: "as a results-driven firm" counts), "best
 * interest(s)", "leading (up) to", "prevailing" ("prevailing wage"), "no one" and "top" before any other word ("on top of").
 * Residuals, accepted: other paraphrases ("we get you paid", "the right outcome"), comparisons without these words ("better than
 * other firms"), and "strongest", "toughest" and "highest" (ruled out 2026-10-09: too many false positives).
 */
const NEVER_IN_LAW_COPY: readonly RegExp[] = [
  new RegExp(
    `\\b(win(s|ning)?|won(?![\u0027\u2019]t)|results|(?<!\\bas${J}a${J})result|success(ful(ly)?)?|favou?rable|maximi[sz](e[ds]?|ing)|maximum|you${J}deserve|proven|track${J}record|undefeated|winners?|successes|succeed(s|ed|ing)?|victor(y|ies|ious)|prevail(s|ed)?)\\b`,
    "i",
  ),
  // "#one" starts with a symbol, where \b does not hold, so the group may also start at a "#".
  new RegExp(
    `(?:\\b|(?=#))(best(?!${J}interests?\\b)|finest|greatest|leading(?!${J}(up${J})?to\\b)|premier|foremost|top${J}(lawyers?|attorneys?|firms?|notch|tier|choice)|number${J}one|unmatched|unrivall?ed|unbeatable|unparall?ell?ed|second${J}to${J}none|world${J}class|elite|most${J}(experienced|trusted|respected|skilled|successful|qualified|knowledgeable|reliable|aggressive|dedicated)|no\\.${J}?one|#${J}?one|top${J}(law|legal|ranked)|first${J}rate|unsurpassed|unequall?ed|peerless)\\b`,
    "i",
  ),
];

/** An "Other" business type that names a legal business ("Attorney", "Family law practice"): its copy follows the law rules. */
const LEGAL_BUSINESS = /\b(law|lawyers?|attorneys?|legal|solicitors?|barristers?|counsel|paralegals?)\b/i;

/** Whether the law rules hold this business's AI copy. */
const isLegalBusiness = (facts: Facts): boolean => facts.trade === "law" || (facts.trade === "other" && facts.tradeOther !== undefined && LEGAL_BUSINESS.test(facts.tradeOther));

/** The words in `text` that state something the AI may not, or something these facts do not back (empty when fine). */
export function aiClaims(text: string, facts: Facts): string[] {
  const read = readings(text);
  const find = (pattern: RegExp): string | undefined => {
    for (const reading of read) {
      const word = pattern.exec(reading)?.[0];
      if (word !== undefined) return word;
    }
    return undefined;
  };
  const found: string[] = [];
  for (const pattern of NEVER_IN_AI_COPY) {
    const word = find(pattern);
    if (word !== undefined) found.push(word);
  }
  for (const { pattern, backedBy } of NEEDS_A_FACT_IN_AI_COPY) {
    const word = find(pattern);
    if (word !== undefined && !backedBy(facts)) found.push(word);
  }
  if (isLegalBusiness(facts)) {
    for (const pattern of NEVER_IN_LAW_COPY) {
      const word = find(pattern);
      if (word !== undefined) found.push(word);
    }
  }
  return found;
}

/**
 * The dotted path core's ownerEditedPaths uses for a copy field that proseIn found at `path`: "copy.heroHeadline",
 * "copy.sectionIntros.faq", "copy.serviceDescriptions.<trimmed service name>", and "copy.faq" for any part of the faq.
 */
function ownerPathOf(copy: Copy, path: ReadonlyArray<string | number>): string {
  const [head, index] = path;
  if (head === "faq") return "copy.faq";
  if (head === "serviceDescriptions" && typeof index === "number") return `copy.serviceDescriptions.${copy.serviceDescriptions[index]?.service.trim() ?? ""}`;
  return ["copy", ...path].join(".");
}

/** One issue per copy field that makes a claim, in the shape and words of SiteDocument's claim issues, so the repair loop feeds them back. */
export function aiClaimIssues(copy: Copy, facts: Facts, ownerEditedPaths: readonly string[] = []): Issue[] {
  const skipped = new Set(ownerEditedPaths);
  return proseIn(copy).flatMap(([path, text]) => {
    if (skipped.has(ownerPathOf(copy, path))) return [];
    const claims = aiClaims(text, facts);
    if (claims.length === 0) return [];
    return [{ path: ["copy", ...path], code: "custom", message: `Copy states something the owner's facts do not back: ${claims.map((c) => JSON.stringify(c)).join(", ")}` }];
  });
}

/**
 * The AI-only claim check over a composed page's copy, for the facts as they are now (public: Plan 4 runs it where it composes
 * the page, after SiteDocument, because SiteDocument alone accepts AI wording whose fact the owner has since turned off). Fields
 * whose path is in `ownerEditedPaths` (core's ownerEditedPaths) are the owner's own text and are skipped; the owner's text stays
 * under claims.ts. Issues are the ones checkDraft gives.
 */
export function aiCopyIssues(facts: Facts, copy: Copy, ownerEditedPaths: readonly string[]): Issue[] {
  return aiClaimIssues(copy, facts, ownerEditedPaths);
}
