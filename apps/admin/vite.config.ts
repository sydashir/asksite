import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_FLOOR_BUILD_TARGET } from "@asksite/app-common";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildVars, workerConfigPath } from "../app/build-config.ts";
import { adminHeadersFile, undeployableLocalConfig } from "./build-config.ts";

/** Writes _headers into the client build output only. */
function staticHeaders(rootDomain: string, production: boolean): Plugin {
  return {
    name: "asksite-static-headers",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: adminHeadersFile(rootDomain, production) });
    },
  };
}

/**
 * After the Cloudflare plugin has written the build's output config (its buildApp hook is also "post", and runs first
 * because it is listed first), makes a development build undeployable to production (F5; undeployableLocalConfig).
 * The config is found as `wrangler deploy` finds it, through .wrangler/deploy/config.json.
 */
function localBuildNotDeployable(root: string): Plugin {
  return {
    name: "asksite-local-build-not-deployable",
    apply: "build",
    buildApp: {
      order: "post",
      async handler() {
        const redirect = resolve(root, ".wrangler/deploy/config.json");
        const { configPath } = JSON.parse(readFileSync(redirect, "utf8")) as { configPath: string };
        const output = resolve(dirname(redirect), configPath);
        const config = JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown>;
        writeFileSync(output, JSON.stringify(undeployableLocalConfig(config)));
      },
    },
  };
}

// Vite 8's own default target list (vite.dev/config/build-options, v8.3.1: "baseline-widely-available" is
// ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4']) with the Safari/iOS entries taken from the
// one floor module, exactly as the owner app does.
const BUILD_TARGET = ["chrome111", "edge111", "firefox114", ...BROWSER_FLOOR_BUILD_TARGET];

// Same modes as the owner app: production, development and e2e (test fakes, output in dist-e2e).
export default defineConfig(({ mode }) => {
  const rootDomain = buildVars(mode, import.meta.url)["ROOT_DOMAIN"];
  if (rootDomain === undefined) throw new Error("ROOT_DOMAIN is not set in the Worker config");
  return {
    plugins: [
      react(),
      tailwindcss(),
      basicSsl(),
      staticHeaders(rootDomain, mode === "production"),
      cloudflare({
        configPath: workerConfigPath(mode),
        ...(mode === "e2e" ? { persistState: { path: ".wrangler/e2e-state" } } : {}),
      }),
      ...(mode === "development" ? [localBuildNotDeployable(fileURLToPath(new URL(".", import.meta.url)))] : []),
    ],
    define: { __ROOT_DOMAIN__: JSON.stringify(rootDomain) },
    build: { outDir: mode === "e2e" ? "dist-e2e" : "dist", target: BUILD_TARGET },
    server: { host: "admin.localhost", port: 8788, strictPort: true },
    preview: { host: "admin.localhost", port: 8788, strictPort: true },
  };
});
