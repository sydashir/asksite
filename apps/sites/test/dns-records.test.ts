import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RESERVED_SLUGS } from "@asksite/core";
import { describe, expect, it } from "vitest";

const { records } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../deploy/dns-records.json"), "utf8")) as {
  records: Array<{ type: string; name: string; proxied: boolean }>;
};

describe("deploy/dns-records.json", () => {
  it("gives no DNS label to a name that could be a site", () => {
    for (const { name } of records) {
      const firstLevel = name.split(".").at(-1) ?? "";
      const safe = firstLevel === "@" || firstLevel === "*" || firstLevel.startsWith("_") || RESERVED_SLUGS.has(firstLevel);
      expect(safe, `${name} uses the label "${firstLevel}"`).toBe(true);
    }
  });

  it("proxies the two Worker records through Cloudflare", () => {
    expect(records.filter((r) => r.type === "AAAA")).toEqual([
      expect.objectContaining({ name: "@", proxied: true }),
      expect.objectContaining({ name: "*", proxied: true }),
    ]);
  });
});
