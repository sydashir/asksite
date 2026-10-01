import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// §2.2 / §9.1: owner and visitor text reaches the screen only as React text nodes. This test is
// the lint rule: it fails if any client source file writes raw HTML.
const RAW_HTML = /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("client source", () => {
  it("never writes raw HTML", () => {
    const root = new URL("../../src/client", import.meta.url).pathname;
    const offenders = files(root).filter((file) => RAW_HTML.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the check itself catches a raw-HTML write", () => {
    expect(RAW_HTML.test("<div dangerouslySetInnerHTML={{ __html: x }} />")).toBe(true);
    expect(RAW_HTML.test("el.innerHTML = value")).toBe(true);
  });
});
