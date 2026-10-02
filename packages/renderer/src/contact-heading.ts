// A one-word label is fine on a button ("Book") but reads as a bare template label as a heading.
const ONE_WORD_HEADING: Readonly<Record<string, string>> = {
  book: "Request a booking",
  quote: "Request a quote",
  estimate: "Request an estimate",
  schedule: "Request a visit",
  contact: "Send us a request",
  enquire: "Send us a request",
  inquire: "Send us a request",
  call: "Send us a request",
};

/** The contact section's heading: the owner's label when it has two or more words, else a fuller fixed heading. */
export function contactHeading(cta: string): string {
  const label = cta.trim();
  if (label.split(/\s+/).length >= 2) return label;
  const key = label.replace(/[.!]+$/, "").toLowerCase();
  return ONE_WORD_HEADING[key] ?? "Send us a request";
}
