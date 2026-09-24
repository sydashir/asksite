/** The UTC calendar day of an epoch-millisecond time, e.g. "2026-09-24". */
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** Epoch milliseconds of 00:00 UTC on the day of `now`. */
export const utcDayStart = (now: number): number => Date.parse(`${utcDay(now)}T00:00:00.000Z`);

export const TTL = { inviteMs: 7 * 86_400_000, loginTokenMs: 15 * 60_000, sessionMs: 30 * 86_400_000 } as const;
