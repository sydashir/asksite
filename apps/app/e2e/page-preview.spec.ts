import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { APP } from "./support.ts";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const PREVIEW = fileURLToPath(new URL("../src/client/components/page-preview.tsx", import.meta.url));
const ENTRY = fileURLToPath(new URL("./__preview-harness-entry.js", import.meta.url));

/** The shared PagePreview alone on a page: `window.show(html)` renders it with that one document (the editor's html mode). */
async function harnessBundle(): Promise<string> {
  const entry = `
    import { createElement } from "react";
    import { createRoot } from "react-dom/client";
    import { PagePreview } from ${JSON.stringify(PREVIEW)};
    const root = createRoot(document.getElementById("root"));
    window.show = (html) => root.render(createElement(PagePreview, { pages: [{ page: "home", html }], frameTitle: "harness" }));
  `;
  const result = await build({
    root: APP_DIR,
    configFile: false,
    logLevel: "silent",
    plugins: [
      react(),
      { name: "harness-entry", resolveId: (id) => (id === ENTRY ? id : null), load: (id) => (id === ENTRY ? entry : null) },
    ],
    build: { write: false, lib: { entry: ENTRY, formats: ["iife"], name: "Harness" } },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ("output" in r ? r.output : []));
  const chunk = outputs.find((o) => o.type === "chunk");
  if (chunk === undefined || chunk.type !== "chunk") throw new Error("the preview harness did not build");
  return chunk.code;
}

// The editor will hand PagePreview a NEW document each time the owner edits. A new srcdoc fires `load` again; that is the new
// document arriving, never a link inside it leaving. Only a real in-frame navigation remounts the frame and says links are off.
test("a new document for the same page is not a navigation away, a real link click still is", async ({ page }) => {
  const bundle = (await harnessBundle()).replaceAll("</script", "<\\/script");
  await page.route(`${APP}/__preview-harness`, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><meta charset="utf-8"><title>harness</title><div id="root"></div><script>${bundle}</script>` }),
  );
  await page.goto(`${APP}/__preview-harness`);
  const show = (html: string) => page.evaluate((h) => (window as unknown as { show: (html: string) => void }).show(h), html);
  const frame = page.frameLocator("iframe");
  const linksOff = page.getByText("Links are turned off in the preview.");

  await show(`<h1>First draft</h1>`);
  await expect(frame.locator("h1")).toHaveText("First draft");
  await page.locator("iframe").evaluate((el) => el.setAttribute("data-first", "yes"));

  await show(`<h1>Second draft</h1><a href="/services">Services</a>`);
  await expect(frame.locator("h1")).toHaveText("Second draft");
  await expect(page.locator("iframe")).toHaveAttribute("data-first", "yes");
  await expect(linksOff).toHaveCount(0);

  await frame.getByRole("link", { name: "Services" }).click();
  await expect(linksOff).toBeVisible();
  await expect(frame.locator("h1")).toHaveText("Second draft");
  await expect(page.locator("iframe")).not.toHaveAttribute("data-first", "yes");
});
