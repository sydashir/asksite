// Defaults; the caps are the user's call (design §12). Every one is an exact D1 count.
export const LIMITS = {
  generationsPerSitePerDay: 5,
  generationsPerOwnerTotal: 20,
  generationsPerOwnerPerDay: 5, // regenerations only, all the owner's sites together per UTC day; first builds neither count nor are refused (Decision 30)
  defaultDailyModelLimit: 8, // model-calling jobs per UTC day, all owners: the money-safe fallback when no valid setting or env value exists (Decision 4)
  uploadsPerSite: 40, // non-deleted
  uploadsPerSiteTotal: 150, // every upload ever, soft-deleted included: bounds R2 and Images spend
  uploadMaxBytes: 10 * 1024 * 1024,
  loginTokensPerOwnerPerHour: 5,
  loginTokensPerOwnerPerDay: 10,
  leadsPerSitePerDay: 50,
  leadsPerNetworkPerSitePerDay: 3, // one network (ipRateKey: IPv4 whole, IPv6 /64) on one site, spam included (A15)
  leadsPerNetworkPerDay: 5, // one network across all sites, spam included (A15)
  leadRetentionDays: 180,
  spamLeadRetentionDays: 30, // spam = 1 rows only (owners never see them); every other lead, daily_cap ones included, keeps leadRetentionDays
  publishRequestsPerSitePerDay: 20, // publish clicks (versions) per site per UTC day: bounds D1 and R2 growth (Plan 2 Decision 25)
  factsJsonMaxBytes: 307_200, // 300 KiB: the largest valid Facts is 306,352 bytes once JSON-encoded (A8b, A9; test/schemas.test.ts)
  briefJsonMaxBytes: 74_752, // 73 KiB: the largest valid Brief is 73,865 bytes once JSON-encoded (A8; test/schemas.test.ts)
  editsJsonMaxBytes: 436_224, // 426 KiB: the largest valid OwnerEdits is 435,829 bytes once JSON-encoded (A8c, A12; test/schemas.test.ts)
} as const;
