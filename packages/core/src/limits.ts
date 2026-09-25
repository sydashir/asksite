// Defaults; the caps are the user's call (design §12). Every one is an exact D1 count.
export const LIMITS = {
  generationsPerSitePerDay: 5,
  generationsPerOwnerTotal: 20,
  defaultDailyModelLimit: 30, // model-calling jobs per UTC day, all owners (overridden by settings / env)
  uploadsPerSite: 40, // non-deleted
  uploadsPerSiteTotal: 150, // every upload ever, soft-deleted included: bounds R2 and Images spend
  uploadMaxBytes: 10 * 1024 * 1024,
  loginTokensPerOwnerPerHour: 5,
  loginTokensPerOwnerPerDay: 10,
  leadsPerSitePerDay: 50,
  leadRetentionDays: 180,
  publishRequestsPerSitePerDay: 20, // publish clicks (versions) per site per UTC day: bounds D1 and R2 growth (Plan 2 Decision 25)
  factsJsonMaxBytes: 307_200, // 300 KiB: the largest valid Facts is 306,552 bytes once JSON-encoded (A8b; test/schemas.test.ts)
  briefJsonMaxBytes: 74_752, // 73 KiB: the largest valid Brief is 73,865 bytes once JSON-encoded (A8; test/schemas.test.ts)
  editsJsonMaxBytes: 436_224, // 426 KiB: the largest valid OwnerEdits is 435,810 bytes once JSON-encoded (A8c; test/schemas.test.ts)
} as const;
