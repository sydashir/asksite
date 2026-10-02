// What the browser tests cannot do themselves: change the state of the RUNNING sites Worker, through the real
// publishing functions and the same local state `apps/sites/e2e/playwright.config.ts` serves (.wrangler/e2e-state,
// through the tools config that global-setup.ts's first seed wrote).
// Usage: node apps/sites/e2e/operate.ts seed <slug>:<fixture>:<design> ...
//        node apps/sites/e2e/operate.ts approve-v2 | take-down | restore <slug>
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EMPTY_EDITS } from "@asksite/core";
import { approveVersion, createPendingVersion, restore, takeDown } from "@asksite/publishing";
import { DESIGN_IDS, SiteDocument, type DesignId, type SiteDocumentInput } from "@asksite/site-schema";
import { checkLocalToolsConfig, localStatePath, seedDemoSite, seedDocument, type ToolsEnv } from "../dev/seed.ts";
import { V2_COPY } from "./lifecycle.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const PERSIST_TO = ".wrangler/e2e-state";
const ROOT = "localhost:8789";
const REVIEWER = "e2e@localhost";

type Env = ToolsEnv & { ROOT_DOMAIN: string };

/** The second version of a live site: its own document with a new hero headline and Services intro, created and approved. */
async function approveV2(env: Env, slug: string): Promise<void> {
  const site = await env.DB.prepare("SELECT s.id, s.owner_id, v.document_json FROM sites s JOIN site_versions v ON v.id = s.live_version_id WHERE s.slug = ?")
    .bind(slug)
    .first<{ id: string; owner_id: string; document_json: string }>();
  if (site === null) throw new Error(`${slug} has no live version`);
  const live = JSON.parse(site.document_json) as SiteDocumentInput;
  const document = SiteDocument.parse({
    ...live,
    copy: { ...live.copy, heroHeadline: V2_COPY.heroHeadline, sectionIntros: { ...live.copy?.sectionIntros, services: V2_COPY.servicesIntro } },
  });
  const now = Date.now();
  const version = await createPendingVersion(env, { siteId: site.id, ownerId: site.owner_id, slug, document, edits: EMPTY_EDITS, generationId: null, now });
  const row = await env.DB.prepare("SELECT html_sha256 FROM site_versions WHERE id = ?").bind(version.id).first<{ html_sha256: string }>();
  await approveVersion(env, { versionId: version.id, htmlSha256: row?.html_sha256 ?? "", reviewer: REVIEWER, note: "E2E second version", indexable: true, now });
}

async function siteId(env: Env, slug: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind(slug).first<{ id: string }>();
  if (row === null) throw new Error(`No site ${slug}`);
  return row.id;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const { getPlatformProxy } = await import("wrangler");
  const configPath = join(REPO, "apps/sites/wrangler.tools.jsonc");
  checkLocalToolsConfig(configPath);
  const proxy = await getPlatformProxy<ToolsEnv>({ configPath, persist: { path: localStatePath(PERSIST_TO) }, remoteBindings: false });
  try {
    const env: Env = { ...proxy.env, ROOT_DOMAIN: ROOT };
    if (command === "seed") {
      for (const spec of args) {
        const [slug = "", fixtureName = "", design = ""] = spec.split(":");
        const known = DESIGN_IDS.find((id): id is DesignId => id === design);
        if (known === undefined || !/^[a-z-]+$/.test(fixtureName)) throw new Error(`Bad site spec ${spec}`);
        const fixture = JSON.parse(readFileSync(join(REPO, "fixtures", `${fixtureName}.json`), "utf8")) as SiteDocumentInput;
        const document = seedDocument(fixture, { design: known, heroPhoto: false });
        await seedDemoSite(env, { slug, document, now: Date.now(), ownerEmail: `${slug}-owner@example.com`, indexable: true });
      }
    } else {
      const slug = args[0] ?? "";
      if (command === "approve-v2") await approveV2(env, slug);
      else if (command === "take-down") await takeDown(env, { siteId: await siteId(env, slug), reviewer: REVIEWER, reason: "E2E takedown", purgeMedia: false, now: Date.now() });
      else if (command === "restore") {
        const id = await siteId(env, slug);
        const down = await env.DB.prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(id).first<{ taken_down_at: number | null }>();
        await restore(env, { siteId: id, reviewer: REVIEWER, expectedTakenDownAt: down?.taken_down_at ?? 0, now: Date.now() });
      }
      else throw new Error(`Unknown command ${command}`);
    }
  } finally {
    await proxy.dispose();
  }
}

await main();
