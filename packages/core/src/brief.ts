import { z } from "zod";

export const TONES = ["friendly", "professional", "no-nonsense"] as const;
export const GOALS = ["call", "quote", "book"] as const;

// Same hidden-character rule as Facts text (\p{Cc} and \p{Cf} rejected, U+200D allowed), except "\n" is also allowed.
const briefText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/(?!\n)\p{Cc}|(?!\u200D)\p{Cf}/u.test(s), { error: "Invisible or control characters are not allowed" });

/** What the owner tells us about tone and goals. Sent to the model as data; never rendered. */
export const Brief = z.strictObject({
  tone: z.enum(TONES),
  goal: z.enum(GOALS),
  differentiator: briefText(140).optional(), // "What makes you different?"
  notes: briefText(2000).optional(), // "Pretend you're texting a friend..."
  comments: z
    .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), briefText(500))
    .refine((c) => Object.keys(c).length <= 20)
    .default({}), // per-question comments, keyed by question id
  reviewsAreReal: z.boolean().default(false), // owner attests pasted reviews are real (FTC)
});
export type Brief = z.infer<typeof Brief>;
