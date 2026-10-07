import { worstCaseJobMicrousd } from "@asksite/generation";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The settings page shows dailyModelLimit x worstCaseJobMicrousd(MODEL_PROVIDER, MODEL_ID) (design
// §6.3, §3.2 step 5). Plan 3 answers null for a model it has no recorded price for (its decision 11),
// and the page then says "Unknown", so both of the admin's configurations must name a priced model.
const read = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
const production = (JSON.parse(read("wrangler.jsonc")) as { vars: Record<string, string> }).vars;
const development = Object.fromEntries(
  read(".dev.vars.example")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

describe("the admin's configured model is priced by Plan 3", () => {
  it.each([
    ["production", production],
    ["development", development],
  ])("%s", (_name, vars) => {
    expect(worstCaseJobMicrousd(vars["MODEL_PROVIDER"] ?? "", vars["MODEL_ID"] ?? "")).not.toBeNull();
  });
});
