import type { Issue } from "@asksite/core";
import { asReadOnPage, foldings, NEEDS_A_FACT, proseIn, type Copy, type Facts } from "@asksite/site-schema";

// Claims the model must not make in its copy. These rules are AI-only: aiClaims runs in checkDraft and nowhere
// else. Owner text, stored documents and render() are not checked by them. The owner may write "lic." or "free
// of charge" on their own site, and a stored page never starts failing a rule added after it was made; only what the
// model writes is held to the stricter list, because the model has no facts it can point to. A refusal goes back to
// the model as a repair issue (generate.ts); if every attempt is refused, the generation ends without that answer. The
// owner never sees these refusals. site-schema's checker (claims.ts) is unchanged and runs first.
//
// Each text is matched as claims.ts reads it: as typed, then folded (look-alike letters), every dash read by
// asReadOnPage, and the words of a multi-word claim joined by a hyphen, a space or a dash character. A claim any
// reading finds counts. Word lists, not every paraphrase: the owner still approves every page.

/** The joiner between the words of a multi-word claim: hyphen, space, figure dash, en dash, em dash or minus sign (as claims.ts). */
const J = "[-\\u2012\\u2013\\u2014\\u2212 ]";

const NEVER_IN_AI_COPY: readonly RegExp[] = [
  new RegExp(`\\bwithin${J}(the|an?)${J}hour\\b`, "i"), // a response time no fact backs
  new RegExp(`\\b(state|board|city|county)${J}approved\\b`, "i"), // a licence paraphrase
  new RegExp(`\\bbackground${J}check(s|ed|ing)?\\b`, "i"),
  /\bvetted\b/i,
  // Time in business comes from yearFounded. "long time" with a space is usually no claim ("lasts a long time"), so only
  // the closed and dashed forms count; the written residual: every space form (any whitespace run) is accepted, e.g.
  // "a long time local business", "serving Austin for a long time".
  /\b(long[-\u2012\u2013\u2014\u2212]?time|seasoned)\b/i,
  /\b(raves?|raved|recommended)\b/i, // "we recommend" is advice and stays allowed
  /[\u2039\u203A\u301D-\u301F\uFF02]/, // quote marks claims.ts does not list
  // A phrase in straight single quotes: an opening ' at a word start (at the start of the text or after a space, a
  // colon, a semicolon, a comma or a dash, or after a "(" that itself follows one of those; not after a letter or a
  // second "(": code such as f('x') quotes nobody, and the XSS fixture holds some) before a letter, closed
  // by a ' not before a letter. An apostrophe inside a word ("don't", "owner's") never opens or closes, and neither
  // does one that starts an elision, in any case: 'n' (rock 'n' roll), 'em, 'til, 'cause, 'bout, 'round, 'tis, 'twas.
  // The written residual: a real quotation that starts with one of these elision words is accepted ("'Tis the best crew
  // ever' Dana"); it cannot be told apart from the allowed "'Tis the season, 'twas the owners' idea".
  /(?<=(?:^|[\s:;,\u2012-\u2014\u2212-])\(?)'(?!n'|(?:em|til|cause|bout|round|tis|twas)(?!\p{L}))\p{L}(?:[^']|'(?=\p{L}))*'(?!\p{L})/iu,
];

/** claims.ts's own backing for its seven-days rule (24/7 service, or opening hours on all seven days), taken from NEEDS_A_FACT. */
const sevenDaysBacking = NEEDS_A_FACT.find(({ pattern }) => pattern.test("seven days a week"))?.backedBy;
if (sevenDaysBacking === undefined) throw new Error("claims.ts lost its seven-days rule");

/** Wording allowed only when the owner's facts back it. */
const NEEDS_A_FACT_IN_AI_COPY: ReadonlyArray<{ readonly pattern: RegExp; readonly backedBy: (facts: Facts) => boolean }> = [
  { pattern: /\blic\./i, backedBy: (facts) => facts.licences.length > 0 },
  // "ins." counts on its own, not after a letter or after a letter and a hyphen ("check-ins.", "walk-ins."); "lic.-ins." counts.
  // The written residual: a word, a hyphen, then "ins." is accepted ("Fully-ins.", "Licensed-and-ins."), the shape of "walk-ins.".
  // Not "coverage" or "covered": they describe the service area.
  { pattern: /(?<!\p{L}-?)\bins\.|\bliabilit(?:y|ies)/iu, backedBy: (facts) => facts.insured },
  {
    pattern: new RegExp(`\\b(after${J}hours|all${J}hours|nights${J}and${J}holidays|holidays|every${J}day|(open|available)${J}daily)\\b`, "i"), // "daily" alone is not a claim
    backedBy: sevenDaysBacking,
  },
  // "free" in any form, a hyphenated compound too ("stress-free"), but not inside a longer word ("freedom", "FreeFlow").
  { pattern: /(?<!\p{L})free(?!\p{L})/iu, backedBy: (facts) => facts.freeEstimates },
  {
    pattern: new RegExp(`\\b(zero${J}cost|gratis|on${J}the${J}house|never${J}charge|without${J}charge|no${J}fees?)\\b`, "i"),
    backedBy: (facts) => facts.freeEstimates,
  },
];

/** The words in `text` that state something the AI may not, or something these facts do not back (empty when fine). */
export function aiClaims(text: string, facts: Facts): string[] {
  const read = [text, ...foldings(text)].map(asReadOnPage);
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
  return found;
}

/** One issue per copy field that makes a claim, in the shape and words of SiteDocument's claim issues, so the repair loop feeds them back. */
export function aiClaimIssues(copy: Copy, facts: Facts): Issue[] {
  return proseIn(copy).flatMap(([path, text]) => {
    const claims = aiClaims(text, facts);
    if (claims.length === 0) return [];
    return [{ path: ["copy", ...path], code: "custom", message: `Copy states something the owner's facts do not back: ${claims.map((c) => JSON.stringify(c)).join(", ")}` }];
  });
}
