import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_FLOOR_BUILD_TARGET } from "@asksite/app-common";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildVars, headersFile, undeployableLocalConfig, workerConfigPath } from "./build-config.ts";

/** Writes _headers into the client build output only. */
function staticHeaders(rootDomain: string, production: boolean): Plugin {
  return {
    name: "asksite-static-headers",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(rootDomain, production) });
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
// one floor module, so the floor is never written twice.
const BUILD_TARGET = ["chrome111", "edge111", "firefox114", ...BROWSER_FLOOR_BUILD_TARGET];

// Modes: production (`vite build`), development (`vite dev`, `vite build --mode development`)
// and e2e (`vite build --mode e2e`: the Worker with test fakes, output in dist-e2e).
export default defineConfig(({ mode }) => {
  const vars = buildVars(mode, import.meta.url);
  const rootDomain = vars["ROOT_DOMAIN"];
  const supportEmail = vars["SUPPORT_EMAIL"];
  // Empty in production until Task 27 sets the real sitekey: the sign-in form then has no widget and fails closed.
  const siteKey = vars["TURNSTILE_SITE_KEY"] ?? "";
  if (rootDomain === undefined || supportEmail === undefined) throw new Error("ROOT_DOMAIN and SUPPORT_EMAIL must be set in the Worker config");
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
    define: { __ROOT_DOMAIN__: JSON.stringify(rootDomain), __SUPPORT_EMAIL__: JSON.stringify(supportEmail), __TURNSTILE_SITE_KEY__: JSON.stringify(siteKey) },
    build: { outDir: mode === "e2e" ? "dist-e2e" : "dist", target: BUILD_TARGET },
    server: { host: "app.localhost", port: 8787, strictPort: true },
    preview: { host: "app.localhost", port: 8787, strictPort: true },
  };
});
