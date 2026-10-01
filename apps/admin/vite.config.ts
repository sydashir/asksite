import { BROWSER_FLOOR_BUILD_TARGET } from "@asksite/app-common";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildVars, workerConfigPath } from "../app/build-config.ts";
import { adminHeadersFile } from "./build-config.ts";

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
    ],
    define: { __ROOT_DOMAIN__: JSON.stringify(rootDomain) },
    build: { outDir: mode === "e2e" ? "dist-e2e" : "dist", target: BUILD_TARGET },
    server: { host: "admin.localhost", port: 8788, strictPort: true },
    preview: { host: "admin.localhost", port: 8788, strictPort: true },
  };
});
