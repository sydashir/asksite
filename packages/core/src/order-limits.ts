// The shop's order limits (pages lane proposal 1.6). Defaults; the numbers are the user's call, as LIMITS's are. Every
// cap is an exact D1 count over the UTC day.
export const ORDER_LIMITS = {
  /** Orders one network (ipDailyKey: an IPv6 /48, an IPv4 address whole) may place on one site a day, spam included. */
  perNetworkPerSitePerDay: 5,
  /** Orders one site takes a day, spam included; past it the site refuses orders until 00:00 UTC. */
  perSitePerDay: 50,
  /** Order emails one site may send a day (its slice of ORDER_EMAILS_PER_DAY), so one attacked shop cannot use up the others'. */
  emailsPerSitePerDay: 5,
  /** $5,000.00: the most one order may total with no payment taken (step 1); above it the shop asks the buyer to call. */
  maxOrderCents: 500_000,
  /** A second tap on Place order with the same cart arrives within this time: it lands on the first order. */
  repeatWindowMs: 120_000,
} as const;
