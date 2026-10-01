import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { LINKS_OFF } from "./frame-links.ts";
import { APP } from "./support.ts";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const PREVIEW = fileURLToPath(new URL("../src/client/components/page-preview.tsx", import.meta.url));
const ENTRY = fileURLToPath(new URL("./__preview-harness-entry.js", import.meta.url));

/** The shared PagePreview alone on a page: `window.show(html)` renders it with that one document (the editor's html mode). */
async function harnessBundle(): Promise<string> {
  const entry = `
    import { createElement, Fragment } from "react";
    import { createRoot } from "react-dom/client";
    import { PagePreview } from ${JSON.stringify(PREVIEW)};
    const root = createRoot(document.getElementById("root"));
    let current = "";
    // Always the same two slots (the preview, then an optional marker), so the marker never remounts the preview.
    const draw = (html, n) => {
      current = html;
      root.render(createElement(Fragment, null,
        createElement(PagePreview, { pages: [{ page: "home", html }], frameTitle: "harness" }),
        n === null ? null : createElement("p", { id: "mark" }, String(n))));
    };
    window.show = (html) => draw(html, null);
    // A render from outside any event: the same default lane as the frame's load event (see the barrier note in the spec).
    window.mark = (n) => draw(current, n);
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

type Harness = Window & { show: (html: string) => void; mark: (n: number) => void; loaded?: Promise<void> };

/** Opens the harness page and returns what both tests share. */
async function openHarness(page: Page) {
  const bundle = (await harnessBundle()).replaceAll("</script", "<\\/script");
  await page.route(`${APP}/__preview-harness`, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><meta charset="utf-8"><title>harness</title><div id="root"></div><script>${bundle}</script>` }),
  );
  await page.goto(`${APP}/__preview-harness`);
  const frame = page.frameLocator("iframe");
  return {
    frame,
    linksOff: page.getByText(LINKS_OFF),
    show: (html: string) => page.evaluate((h) => (window as unknown as Harness).show(h), html),
    /** Marks the current iframe element, so a later check can tell it from a mounted-again one. */
    markFirst: () => page.locator("iframe").evaluate((el) => el.setAttribute("data-first", "yes")),
  };
}

// The editor will hand PagePreview a NEW document each time the owner edits. A new srcdoc fires `load` again; that is the new
// document arriving, never a link inside it leaving. Only a real in-frame navigation remounts the frame and says links are off.
test("a new document for the same page does not say links are turned off", async ({ page }) => {
  const { frame, linksOff, show, markFirst } = await openHarness(page);
  await show(`<h1>First draft</h1>`);
  await expect(frame.locator("h1")).toHaveText("First draft");
  await markFirst();

  // No timing anywhere. (a) Arm a promise on this iframe element for its next `load`, then give the new document, then wait for that
  // load. (b) A React barrier: React's onLoad handler runs first (listenToNonDelegatedEvent("load", iframe) at :22378-22380 adds it when the iframe
  // mounts; ours is added later on the same target), and its setState gets DefaultEventPriority: getEventPriority has no case for "load"
  // (react-dom 19.3.0, cjs/react-dom-client.development.js:26252-26340, the final `default: return DefaultEventPriority`), read through
  // window.event by resolveUpdatePriority (:1495-1501) and requestUpdateLane (:17824-17840). root.render called from page.evaluate runs
  // outside any event, so window.event is undefined and it also gets DefaultEventPriority (:1499-1500). Updates of one lane render
  // together, so once the marker is in the DOM, any announcement that the load caused is committed too.
  await page.evaluate(() => {
    (window as unknown as Harness).loaded = new Promise<void>((done) => document.querySelector("iframe")?.addEventListener("load", () => done(), { once: true }));
  });
  await show(`<h1>Second draft</h1><a href="/services">Services</a>`);
  await page.evaluate(() => (window as unknown as Harness).loaded);
  await page.evaluate(() => (window as unknown as Harness).mark(1));
  await expect(page.locator("#mark")).toHaveText("1");

  await expect(linksOff).toHaveCount(0);
  await expect(frame.locator("h1")).toHaveText("Second draft");
  await expect(page.locator("iframe")).toHaveAttribute("data-first", "yes");
});

test("a real link click in the preview still says links are turned off, and the frame stays on the shown page", async ({ page }) => {
  const { frame, linksOff, show, markFirst } = await openHarness(page);
  await show(`<h1>First draft</h1>`);
  await expect(frame.locator("h1")).toHaveText("First draft");
  await show(`<h1>Second draft</h1><a href="/services">Services</a>`);
  await expect(frame.locator("h1")).toHaveText("Second draft");
  await markFirst();

  await frame.getByRole("link", { name: "Services" }).click();
  await expect(linksOff).toBeVisible();
  await expect(frame.locator("h1")).toHaveText("Second draft");
  await expect(page.locator("iframe")).not.toHaveAttribute("data-first", "yes");
});
