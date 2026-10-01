import { formActionUrl, siteUrl, versionKey } from "@asksite/core";
import { render } from "@asksite/renderer";
import { DESIGN_CSS } from "@asksite/site-css";
import { DESIGN_IDS, type SiteDocument } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPendingVersion } from "../src/index.ts";
import { doc, EDITS, publishingHarness, ROOT, seedSite, versionRow, type PublishEnv } from "./support/harness.ts";

// Until the design builds, every design uses the baseline sheet, so the real DESIGN_CSS cannot tell one design's
// sheet from another's. Here each design gets a sheet of its own, so a version that recorded any other sheet,
// such as a real sheet or the deprecated alias of the impact one, is caught (A12-0 ruling M2). vi.mock is
// hoisted above the imports.
vi.mock("@asksite/site-css", async (importOriginal) => {
  const { sha256Hex } = await import("@asksite/core");
  const { DESIGN_IDS: ids } = await import("@asksite/site-schema");
  const sheet = async (id: string) => {
    const css = `body{--sheet:${id}}`;
    return { css, sha256: await sha256Hex(css) };
  };
  const sheets = await Promise.all(ids.map(async (id) => [id, await sheet(id)] as const));
  return { ...(await importOriginal<typeof import("@asksite/site-css")>()), DESIGN_CSS: Object.fromEntries(sheets) };
});

const harness = publishingHarness("publishing-version-sheets-test");
let env: PublishEnv;
beforeAll(async () => {
  env = await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

describe("createPendingVersion with a different stylesheet per design", () => {
  it("has a sheet per design that no other design and no real sheet shares", async () => {
    const real = await vi.importActual<typeof import("@asksite/site-css")>("@asksite/site-css");
    const hashes = DESIGN_IDS.map((design) => DESIGN_CSS[design].sha256);
    expect(new Set(hashes).size).toBe(DESIGN_IDS.length);
    for (const design of DESIGN_IDS) expect(hashes).not.toContain(real.DESIGN_CSS[design].sha256);
  });

  it.each(DESIGN_IDS)("stores the %s page with its own design's sheet and records that sheet", async (design) => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const plumber = doc();
    const document: SiteDocument = { ...plumber, theme: { ...plumber.theme, design } };
    const summary = await createPendingVersion(env, { siteId, ownerId, slug, document, edits: EDITS, generationId: null, now: 1 });

    const page = render(document, { stylesheets: DESIGN_CSS, formAction: formActionUrl(ROOT, slug, siteId), siteUrl: siteUrl(ROOT, slug) });
    const stored = await (await env.WORK.get(versionKey(siteId, summary.id)))?.text();
    expect(stored).toBe(page.pages[0]!.html);
    expect(stored).toContain(`<style>${DESIGN_CSS[design].css}</style>`);
    expect((await versionRow(env.DB, summary.id))?.stylesheet_sha256).toBe(DESIGN_CSS[design].sha256);
  });
});
