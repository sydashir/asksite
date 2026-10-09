import { z } from "zod";
import { isSafeUrl, parseUrl } from "./url.ts";

// Owner-entered facts. Nothing in here ever comes from the AI.

export const TRADES = ["plumbing", "hvac", "electrical", "roofing", "cleaning", "landscaping", "it", "law", "other"] as const;
/**
 * Where the business serves customers: in the listed places, across the whole country, or worldwide.
 * facts.serviceAreaScope has no default, so documents saved before it existed stay byte-identical;
 * read it only through serviceAreaScopeOf, which treats an absent scope as "places".
 */
export const SERVICE_AREA_SCOPES = ["places", "country", "worldwide"] as const;
export type ServiceAreaScope = (typeof SERVICE_AREA_SCOPES)[number];
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const SOCIAL_NETWORKS = ["facebook", "instagram", "google", "yelp", "nextdoor", "youtube", "linkedin"] as const;

/** Sites each network's link may point at (that host or a subdomain), so a "Facebook" link is really Facebook. */
export const SOCIAL_HOSTS: Record<(typeof SOCIAL_NETWORKS)[number], readonly string[]> = {
  facebook: ["facebook.com"],
  instagram: ["instagram.com"],
  google: ["google.com", "g.page", "maps.app.goo.gl"],
  yelp: ["yelp.com"],
  nextdoor: ["nextdoor.com"],
  youtube: ["youtube.com", "youtu.be"],
  linkedin: ["linkedin.com"],
};

// Control and invisible formatting characters (e.g. U+202E right-to-left override, U+200B
// zero-width space) can disguise text. U+200D (zero-width joiner) stays allowed because emoji
// use it. Owner text is not NFKC-normalised: that would rewrite what the owner typed ("™" -> "TM").
const HIDDEN_CHARACTER = /\p{Cc}|(?!\u200D)\p{Cf}/u;

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !HIDDEN_CHARACTER.test(s), { error: "Control and invisible formatting characters are not allowed" });

const hasNoCredentials = (url: string) => {
  const parsed = parseUrl(url);
  return parsed === undefined || (parsed.username === "" && parsed.password === "");
};

const HttpsUrl = z
  .string()
  .max(2048)
  .refine((url) => isSafeUrl(url, ["https:"]), { error: "Must be an absolute https:// URL" })
  .refine(hasNoCredentials, { error: "URL must not contain a user name or password" });

/** True when `url` is on one of `hosts` or a subdomain. A URL that is invalid for other reasons passes here (HttpsUrl already reported it). */
function isOnHost(url: string, hosts: readonly string[]): boolean {
  if (!isSafeUrl(url, ["https:"]) || !hasNoCredentials(url)) return true;
  const { hostname } = new URL(url);
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/** US number in E.164 form, e.g. +15125550142. Displayed as (512) 555-0142 by the renderer. */
export const UsPhone = z
  .string()
  .regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/, { error: "Phone must be a US number in E.164 form, e.g. +15125550142" });

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Time must be HH:MM (24-hour)" });

export const OpeningHours = z
  .strictObject({ days: z.array(z.enum(DAYS)).min(1).max(7), opens: Time, closes: Time })
  .refine((h) => h.opens < h.closes, { error: "closes must be later than opens", path: ["closes"] });

export const Service = z.strictObject({
  name: text(1, 40),
  /** Whole US dollars. Rendered as "From $89". */
  startingPrice: z.int().min(1).max(100_000).optional(),
});

/** Rendered exactly as entered, e.g. { label: "Arizona ROC", number: "ROC 300933" }. */
export const Licence = z.strictObject({ label: text(1, 40), number: text(1, 30) });

export const Testimonial = z.strictObject({
  quote: text(1, 320),
  name: text(1, 40),
  location: text(1, 40).optional(),
});

export const Photo = z.strictObject({
  url: HttpsUrl,
  alt: text(1, 125),
  width: z.int().min(1).max(10_000),
  height: z.int().min(1).max(10_000),
  caption: text(1, 80).optional(),
});

export const SocialLink = z
  .strictObject({ network: z.enum(SOCIAL_NETWORKS), url: HttpsUrl })
  .refine((link) => isOnHost(link.url, SOCIAL_HOSTS[link.network]), {
    error: "Link must point at that network's own site",
    path: ["url"],
  });

export const Location = z.strictObject({
  /** Optional: service-area businesses often hide their street address. */
  streetAddress: text(1, 80).optional(),
  city: text(1, 40),
  state: z.string().regex(/^[A-Z]{2}$/, { error: "State must be a two-letter code, e.g. TX" }),
  postalCode: z.string().regex(/^\d{5}$/, { error: "ZIP must be five digits" }).optional(),
});

export const ServiceArea = z.strictObject({
  /** City names or ZIP codes. At least one when the scope is "places" (Facts checks it); may be empty otherwise. */
  places: z.array(text(1, 40)).max(30),
  /** Free text such as "Within 25 miles of downtown Austin". Shown as the service-area subtitle. */
  note: text(1, 80).optional(),
});

type IssuePath = readonly PropertyKey[];
const startsWith = (path: IssuePath, prefix: IssuePath) => prefix.every((key, i) => path[i] === key);

/**
 * A cross-field rule runs once the fields it reads parsed cleanly, even while other fields still have
 * problems (zod skips a plain refinement then), so the questionnaire shows it on its own step at once.
 * An issue on a field, inside it or on an object holding it means that field did not parse cleanly.
 */
function parsedCleanly(...fields: IssuePath[]) {
  return (payload: { value: unknown; issues: ReadonlyArray<{ path?: IssuePath | undefined }> }): boolean =>
    typeof payload.value === "object" &&
    payload.value !== null &&
    payload.issues.every(({ path = [] }) => path.length === 0 || !fields.some((field) => startsWith(path, field) || startsWith(field, path)));
}

export const Facts = z
  .strictObject({
    businessName: text(2, 60),
    trade: z.enum(TRADES),
    /** The owner's own business type, e.g. "Bakery". Present exactly when trade is "other". */
    tradeOther: text(2, 40).optional(),
    phone: UsPhone,
    email: z.email().max(254),
    location: Location,
    serviceArea: ServiceArea,
    serviceAreaScope: z.enum(SERVICE_AREA_SCOPES).optional(),
    hours: z.array(OpeningHours).max(7).default([]),
    services: z.array(Service).min(1).max(12),
    licences: z.array(Licence).max(5).default([]),
    insured: z.boolean().default(false),
    /**
     * Stored as a year so the page never goes stale ("Since 1998", not "27 years"). The bound is
     * fixed so validation never reads the clock; plan 4's questionnaire rejects a future year.
     */
    yearFounded: z.int().min(1850).max(2100).optional(),
    emergency247: z.boolean().default(false),
    /** The owner gives free estimates or quotes. Only then may the AI copy say "free". */
    freeEstimates: z.boolean().default(false),
    testimonials: z.array(Testimonial).max(12).default([]),
    heroPhoto: Photo.optional(),
    photos: z.array(Photo).max(12).default([]),
    socialLinks: z.array(SocialLink).max(7).default([]),
  })
  .refine((f) => new Set(f.hours.flatMap((h) => h.days)).size === f.hours.flatMap((h) => h.days).length, {
    error: "A day can appear in only one opening-hours entry",
    path: ["hours"],
  })
  .superRefine(
    (f, ctx) => {
      if (f.trade === "other" && f.tradeOther === undefined) {
        ctx.addIssue({ code: "custom", path: ["tradeOther"], message: "Say what kind of business it is when the trade is other" });
      }
      if (f.trade !== "other" && f.tradeOther !== undefined) {
        ctx.addIssue({ code: "custom", path: ["tradeOther"], message: "Only a business whose trade is other names its own business type" });
      }
    },
    { when: parsedCleanly(["trade"], ["tradeOther"]) },
  )
  .superRefine(
    (f, ctx) => {
      if (serviceAreaScopeOf(f) === "places" && f.serviceArea.places.length === 0) {
        // The same issue the former places.min(1) gave.
        ctx.addIssue({ code: "too_small", origin: "array", minimum: 1, inclusive: true, input: f.serviceArea.places, path: ["serviceArea", "places"] });
      }
    },
    { when: parsedCleanly(["serviceArea", "places"], ["serviceAreaScope"]) },
  );

export type Facts = z.infer<typeof Facts>;
export type Trade = Facts["trade"];
export type Day = (typeof DAYS)[number];
export type OpeningHours = z.infer<typeof OpeningHours>;
export type Photo = z.infer<typeof Photo>;
export type SocialLink = z.infer<typeof SocialLink>;

/** The service-area scope of these facts: "places" when none is stored. */
export function serviceAreaScopeOf(facts: { readonly serviceAreaScope?: ServiceAreaScope | undefined }): ServiceAreaScope {
  return facts.serviceAreaScope ?? "places";
}
