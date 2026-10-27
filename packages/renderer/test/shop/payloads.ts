// The hostile strings every shop test escapes: each XSS payload of the electrical-xss fixture (the cases of
// test/xss.test.ts, read from the fixture so the lists never drift apart), plus quotes, "<", "&", entity look-alikes,
// right-to-left and zero-width characters, a textarea/title breakout and a very long input.
import { loadFixture } from "../../../../fixtures/index.ts";

function fixturePayloads(): string[] {
  const out = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (/[<>"&']|javascript:|onerror|onload/i.test(value)) out.add(value);
    } else if (value !== null && typeof value === "object") for (const v of Object.values(value)) walk(v);
  };
  walk(loadFixture("electrical-xss"));
  return [...out];
}

export const PAYLOADS: readonly string[] = [
  ...fixturePayloads(),
  `'" <>&`,
  "' onmouseover='alert(1)",
  "&lt;script&gt; &amp; &#60;",
  "</textarea><script>alert(1)</script>",
  "</title><script>alert(1)</script>",
  "‮gnp.exe‬ ​‍﻿ zero-width",
  `${"A".repeat(5000)}<script>alert(1)</script>`,
];

/** The payloads, checked: there are enough of them to mean something. */
if (PAYLOADS.length < 25) throw new Error(`Only ${PAYLOADS.length} payloads`);
