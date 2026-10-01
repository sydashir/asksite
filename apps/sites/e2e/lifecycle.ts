import type { DesignId } from "@asksite/site-schema";

// What the lifecycle tests (sites.spec.ts) and the tool that changes the running server's state (operate.ts) share.

/** The engines the lifecycle tests run in: each gets its own site per design, since the tests change the site's state. */
export const LIFECYCLE_ENGINES = ["chromium", "webkit"] as const;
export type LifecycleEngine = (typeof LIFECYCLE_ENGINES)[number];

/** The slug of the site the lifecycle tests of a design change in an engine (global-setup.ts seeds it from plumber-austin). */
export const lifecycleSlug = (design: DesignId, engine: LifecycleEngine): string => `e2e-life-${design}-${engine}`;

/** The copy the second version changes (the first is the fixture's own): Home's hero headline and the Services intro. */
export const V2_COPY = { heroHeadline: "Version two of the Austin plumbers headline", servicesIntro: "Version two of the services intro." } as const;
