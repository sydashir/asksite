/**
 * How long the server counts a piece of the owner's wording: NFKC, then trim, then code points. It mirrors site-schema's `prose`
 * (packages/site-schema/src/copy.ts: `z.string().normalize("NFKC").trim().min(1).max(max)`, where zod's max counts code points), which
 * exports no length of its own. NFKC can make text longer ("…" becomes "..." and counts 3), so a counter that skipped it said "80 of 80"
 * for text the server refuses.
 */
export const wordingLength = (value: string): number => [...value.normalize("NFKC").trim()].length;
