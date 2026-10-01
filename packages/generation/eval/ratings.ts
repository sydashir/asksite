import type { EvalRun } from "./run.ts";

export interface RatingKey {
  item: string;
  candidate: string;
  profileId: string;
  run: number;
}

const HEADER = ["item", "profile", "facts", "heroHeadline", "heroSubheadline", "ctaText", "about", "sectionIntros", "serviceDescriptions", "faq", "sounds_local_1to5", "specific_1to5", "publish_as_is_1to5", "states_unbacked_fact_yes_no"];

/** RFC 4180 quoting, and a leading ' on cells a spreadsheet would run as a formula (OWASP CSV injection). */
const cell = (value: string): string => `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`;

/** Deterministic PRNG (mulberry32) so a sheet can be re-created from its seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The blind human-rating sheet (model-options note §7 step 4): every passing draft, shuffled with
 * `seed`, with the model hidden. The key that maps items back to models goes in a separate file
 * that raters do not open.
 */
export function ratingSheet(runs: readonly EvalRun[], seed: number): { csv: string; key: RatingKey[] } {
  const passing = runs.filter((r) => r.result.ok);
  const next = random(seed);
  const order = passing.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const rows: string[] = [HEADER.join(",")];
  const key: RatingKey[] = [];
  order.forEach((index, n) => {
    const run = passing[index]!;
    if (!run.result.ok) return;
    const { copy } = run.result.draft;
    const { facts } = run.profile.snapshot;
    const item = `R${String(n + 1).padStart(3, "0")}`;
    const factsSummary = `${facts.trade}; services: ${facts.services.map((s) => s.name).join(" / ")}; licensed ${facts.licences.length > 0}; insured ${facts.insured}; 24/7 ${facts.emergency247}; free estimates ${facts.freeEstimates}`;
    rows.push(
      [
        item,
        run.profile.id,
        factsSummary,
        copy.heroHeadline,
        copy.heroSubheadline,
        copy.ctaText,
        copy.about ?? "",
        Object.values(copy.sectionIntros).join(" | "),
        copy.serviceDescriptions.map((d) => `${d.service}: ${d.description}`).join(" | "),
        copy.faq.map((f) => `Q: ${f.question} A: ${f.answer}`).join(" | "),
        "",
        "",
        "",
        "",
      ]
        .map((value, i) => (i === 0 ? value : cell(value)))
        .join(","),
    );
    key.push({ item, candidate: run.candidate, profileId: run.profile.id, run: run.run });
  });
  return { csv: `${rows.join("\n")}\n`, key };
}
