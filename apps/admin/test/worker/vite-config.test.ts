import { describe, expect, it } from "vitest";
import config from "../../vite.config.ts";

// F5 (deploy safety): the plugin that makes a development build undeployable must run in development mode and nowhere
// else. In production it would rename the real build to asksite-admin-local and drop its route, so `pnpm release` would
// silently never update the live Worker; missing in development it reopens the bare `wrangler deploy` hole.
type Plugin = { name?: string };
async function pluginNames(mode: string): Promise<string[]> {
  const resolved = typeof config === "function" ? config({ mode, command: "build", isSsrBuild: false, isPreview: false }) : config;
  const { plugins } = await resolved;
  const flat = (await Promise.all((plugins ?? []) as unknown[])).flat(Infinity) as Plugin[];
  return flat.map((plugin) => plugin.name ?? "");
}

describe("vite.config plugins (F5)", () => {
  it("makes the development build undeployable", async () => {
    expect(await pluginNames("development")).toContain("asksite-local-build-not-deployable");
  });

  it.each(["production", "e2e"])("leaves the %s build untouched", async (mode) => {
    expect(await pluginNames(mode)).not.toContain("asksite-local-build-not-deployable");
  });
});
