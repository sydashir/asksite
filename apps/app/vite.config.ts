import { BROWSER_FLOOR_BUILD_TARGET } from "@asksite/app-common";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildVars, headersFile, workerConfigPath } from "./build-config.ts";

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
    ],
    define: { __ROOT_DOMAIN__: JSON.stringify(rootDomain), __SUPPORT_EMAIL__: JSON.stringify(supportEmail), __TURNSTILE_SITE_KEY__: JSON.stringify(siteKey) },
    build: { outDir: mode === "e2e" ? "dist-e2e" : "dist", target: BUILD_TARGET },
    server: { host: "app.localhost", port: 8787, strictPort: true },
    preview: { host: "app.localhost", port: 8787, strictPort: true },
  };
});
