import { slugIssue } from "@asksite/core";
import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from "obscenity";

// Web addresses are <slug>.<root>, so a slug must never pass for a bank, a big brand, a shipping
// company or a government service. Entries are in slug form without hyphens; "wells-fargo" and
// "wellsfargo" both match "wellsfargo". Only an EXACT match is blocked: "chase-hvac" can be a
// real business named after its owner, so a brand used as one word of a slug is only flagged for
// the human reviewer (slugFlags).
export const BRAND_SLUGS: ReadonlySet<string> = new Set([
  // Platforms, software and devices
  "google", "gmail", "youtube", "android", "apple", "icloud", "itunes", "iphone", "microsoft", "outlook",
  "office365", "hotmail", "windows", "xbox", "amazon", "alexa", "kindle", "facebook", "instagram", "whatsapp",
  "messenger", "meta", "twitter", "tiktok", "snapchat", "linkedin", "pinterest", "reddit", "discord", "telegram",
  "zoom", "slack", "dropbox", "adobe", "docusign", "netflix", "hulu", "disney", "spotify", "yahoo", "aol",
  "ebay", "etsy", "shopify", "wix", "squarespace", "godaddy", "wordpress", "cloudflare", "github", "openai",
  "chatgpt", "anthropic", "claude", "nvidia", "intel", "samsung", "sony", "dell", "lenovo", "roku", "uber",
  "lyft", "doordash", "grubhub", "instacart", "airbnb", "expedia", "tripadvisor",
  // Home-services marketplaces and listings
  "yelp", "nextdoor", "angi", "angieslist", "homeadvisor", "thumbtack", "houzz", "porch", "taskrabbit",
  "craigslist", "zillow", "redfin", "realtor", "trulia", "bbb", "betterbusinessbureau",
  // Payments, banks and money
  "paypal", "venmo", "zelle", "cashapp", "stripe", "visa", "mastercard", "amex", "americanexpress",
  "discover", "chase", "jpmorgan", "wellsfargo", "bankofamerica", "bofa", "citi", "citibank", "capitalone",
  "usbank", "pnc", "truist", "tdbank", "ally", "schwab", "fidelity", "vanguard", "robinhood", "coinbase",
  "binance", "kraken", "metamask", "sofi", "chime", "synchrony", "navyfederal", "usaa", "regions",
  "huntington", "keybank", "fifththird", "santander", "barclays", "hsbc", "westernunion", "moneygram",
  "turbotax", "intuit", "quickbooks", "hrblock", "creditkarma", "experian", "equifax", "transunion",
  // Retail and shipping
  "walmart", "target", "costco", "homedepot", "lowes", "bestbuy", "kroger", "walgreens", "cvs", "samsclub",
  "ikea", "wayfair", "menards", "acehardware", "truevalue", "sherwinwilliams", "usps", "ups", "fedex", "dhl",
  // Telecoms and utilities
  "att", "verizon", "tmobile", "sprint", "comcast", "xfinity", "spectrum", "centurylink", "directv",
  "dukeenergy", "pge", "coned",
  // Government
  "irs", "ssa", "socialsecurity", "medicare", "medicaid", "fema", "dmv", "usgov", "gov", "whitehouse", "fbi",
  "cia", "dhs", "uscis", "treasury", "usa",
  // National home-services franchises and equipment makers
  "rotorooter", "mrrooter", "mrelectric", "mrhandyman", "mrappliance", "servicemaster", "servpro",
  "mollymaid", "merrymaids", "terminix", "orkin", "trugreen", "onehourheating", "benjaminfranklin",
  "aireserv", "carrier", "trane", "lennox", "rheem", "goodman", "kohler", "moen", "generac",
  // Us, and words that claim to be us
  "asksite", "official", "verified", "verification",
]);

// Whole words that may never be one hyphen-separated part of a slug. Names that are also real
// surnames or places (Dickson, Cumming, Hancock) or products ("Spic and Span") are NOT here: a
// substring or profanity-library match would block real businesses, so those are only flagged.
export const BLOCKED_WORDS: ReadonlySet<string> = new Set([
  "fuck", "fucking", "fucker", "motherfucker", "shit", "shitty", "bullshit", "cunt", "bitch", "bitches",
  "asshole", "bastard", "dickhead", "cocksucker", "pussy", "twat", "wanker", "whore", "slut", "nigger",
  "nigga", "faggot", "fag", "retard", "retarded", "kike", "chink", "gook", "wetback", "tranny", "porn",
  "porno", "xxx", "rape", "rapist", "pedo", "pedophile", "nazi", "hitler", "kkk", "jizz", "dildo", "milf",
]);

/** Words scammers use to look official. Flagged for the reviewer, never blocked. */
export const PHISHING_WORDS: ReadonlySet<string> = new Set([
  "secure", "login", "signin", "verify", "account", "bank", "wallet", "password", "refund", "billing",
  "giftcard", "crypto", "update", "unlock", "support",
]);

export type SlugProblem = "invalid" | "reserved" | "blocked";

/** Why the owner may not use this web address, or null when they may. */
export function slugProblem(slug: string): SlugProblem | null {
  const issue = slugIssue(slug);
  if (issue !== null) return issue;
  const words = slug.split("-");
  const joined = words.join("");
  if (BRAND_SLUGS.has(joined)) return "blocked";
  if (words.some((word) => BLOCKED_WORDS.has(word)) || BLOCKED_WORDS.has(joined)) return "blocked";
  return null;
}

const profanity = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });

/** Hints for the human reviewer (ReviewChecks.slugFlags). A flag never blocks anything. */
export function slugFlags(slug: string): string[] {
  const words = slug.split("-");
  const joined = words.join("");
  const pairs = words.slice(1).map((word, i) => `${words[i]}${word}`);
  const brands = [...BRAND_SLUGS].filter(
    (brand) => words.includes(brand) || pairs.includes(brand) || (brand.length >= 6 && joined.includes(brand)),
  );
  const flags = brands.filter((brand) => brand !== joined).map((brand) => `brand:${brand}`);
  for (const word of words) if (PHISHING_WORDS.has(word)) flags.push(`word:${word}`);
  if ((slug.match(/\d/g) ?? []).length >= 4) flags.push("digits");
  if (profanity.hasMatch(words.join(" ")) || profanity.hasMatch(joined)) flags.push("profanity");
  return flags;
}
