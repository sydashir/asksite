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
    import { flushSync } from "react-dom";
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
    // Several documents in ONE task, each committed at once (flushSync): the first frame's own load cannot run in between.
    window.showMany = (list) => {
      for (const html of list) flushSync(() => draw(html, null));
      document.querySelector("iframe")?.setAttribute("data-first", "yes");
    };
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

type Harness = Window & { show: (html: string) => void; showMany: (list: string[]) => void; mark: (n: number) => void; loaded?: Promise<void> };

/** Opens the harness page and returns what both tests share. */
async function openHarness(page: Page) {
  const bundle = await harnessBundle();
  // The page carries the app's real policy (read from GET /), so the sandboxed srcdoc frame inherits what the owner's frame inherits.
  // The bundle is a script file of the page's own origin, because the policy (script-src 'self') blocks an inline one.
  const policy = (await page.request.get(`${APP}/`)).headers()["content-security-policy"] ?? "";
  expect(policy).toContain("font-src");
  await page.route(`${APP}/__preview-harness.js`, (route) => route.fulfill({ contentType: "text/javascript", body: bundle }));
  await page.route(`${APP}/__preview-harness`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      headers: { "content-security-policy": policy },
      body: `<!doctype html><meta charset="utf-8"><title>harness</title><div id="root"></div><script src="/__preview-harness.js"></script>`,
    }),
  );
  await page.goto(`${APP}/__preview-harness`);
  const frame = page.frameLocator("iframe");
  return {
    frame,
    linksOff: page.getByText(LINKS_OFF),
    show: (html: string) => page.evaluate((h) => (window as unknown as Harness).show(h), html),
    showMany: (list: string[]) => page.evaluate((l) => (window as unknown as Harness).showMany(l), list),
    mark: (n: number) => page.evaluate((m) => (window as unknown as Harness).mark(m), n),
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

// The editor sends a new document on every keystroke. Several documents handed over before the first frame's own load has run
// (m6: rapid updates) must end on the LAST one, and a load that belongs to an older document must never be taken for a link.
test("rapid updates show the last document and never say links are turned off", async ({ page }) => {
  const { frame, linksOff, showMany, mark } = await openHarness(page);
  await showMany([`<h1>First draft</h1>`, `<h1>Second draft</h1><a href="/services">Services</a>`, `<h1>Third draft</h1><a href="/services">Services</a>`]);
  await expect(frame.locator("h1")).toHaveText("Third draft");
  // The React barrier of the first test: once the marker is in the DOM, anything the frame's loads announced is committed too.
  await mark(1);
  await expect(page.locator("#mark")).toHaveText("1");
  await expect(linksOff).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveAttribute("data-first", "yes");
  await expect(frame.locator("h1")).toHaveText("Third draft");
});

// A synthetic font made for this test: one square glyph for "A" and an empty .notdef, 284 bytes, built locally with fontTools 4.62.1
// (FontBuilder, then flavor "woff2"). It is our own drawing, not derived from any third-party font, so it carries no licence.
// TODO: when the Bold design's real face lands in site-css, switch this test to it.
const PROBE_FONT = "d09GMgABAAAAAAEcAAoAAAAAAmwAAADWAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAANAocNgE2AiQDCAsGAAQgBVoHJhvLAUiuDngu+g4F+4IE3zLNyVxm4vls5N6fnU1PUA36FBpLKkEh6ziFxDikrbMc8fXoDXF/jk+OjyyPUkrzYEHyyv964MSRC66HT50cn+gAcqBjoB5ZGraAEgw8ZJFi06Sn7qJRh2RqZoB7FfZU3SUoDOwMwU67RGvB/l8WSwAUaASNCWhAejPP+uN4GgjC59fjz3g5xh/8fD9U1weqQ42hQBiXUEcfqsQAgMoJzGGUFlAAAGh3AmIioCxMQ3ol1rablHMXT23iGfUBmbMSOGhvhCNqErc=";

// The Bold design embeds one font as a data: woff2. The preview frame inherits the app's `font-src 'self' data:`; this proves the face
// really loads there, so what the owner previews is what publishes. No timing: load() settles once the face has loaded or failed.
test("a data: font in the preview frame loads under the app's policy", async ({ page }) => {
  const { frame, show } = await openHarness(page);
  await show(`<style>@font-face{font-family:"Probe";src:url(data:font/woff2;base64,${PROBE_FONT}) format("woff2")}h1{font-family:"Probe"}</style><h1>A</h1>`);
  const faces = await frame.locator("h1").evaluate(async () => {
    await document.fonts.load('16px "Probe"', "A").catch(() => []);
    await document.fonts.ready;
    return [...document.fonts].map((face) => `${face.family.replaceAll('"', "")} ${face.status}`);
  });
  expect(faces).toEqual(["Probe loaded"]);
});

// N1 (the moderator, 2026-10-06): "Desktop width" is the true 1280 px layout scaled to fit the column (never above 1), and the preview
// opens on "Phone width" when its column is under 640 px, else on "Desktop width". The default is picked once, at mount.
const WIDE_ONLY = `<style>.wide{display:none}@media(min-width:64rem){.wide{display:block}}</style><p class="wide">Seen from 64rem</p><a href="/services">Services</a>`;
const desktopButton = (page: Page) => page.getByRole("button", { name: "Desktop width" });
const phoneButton = (page: Page) => page.getByRole("button", { name: "Phone width" });
const windowWidth = (page: Page) => page.viewportSize()?.width ?? 1280;

test("a 1280 window opens Desktop width, drawn at 1280 px, so what shows from 64rem shows", async ({ page }) => {
  test.skip(windowWidth(page) !== 1280, "the 1280 window");
  const { frame, show } = await openHarness(page);
  await show(WIDE_ONLY);
  await expect(desktopButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(phoneButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(frame.locator(".wide")).toBeVisible();
  expect(await frame.locator("body").evaluate(() => window.innerWidth)).toBe(1280);
});

test("a 390 window opens Phone width, and Desktop width is the true 1280 px layout scaled to fit", async ({ page }) => {
  test.skip(windowWidth(page) !== 390, "the 390 window");
  const { frame, linksOff, show } = await openHarness(page);
  await show(WIDE_ONLY);
  await expect(phoneButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(desktopButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(frame.locator(".wide")).toBeHidden();

  await desktopButton(page).click();
  await expect(desktopButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(frame.locator(".wide")).toBeVisible();
  expect(await frame.locator("body").evaluate(() => window.innerWidth)).toBe(1280);
  // Scaled to fit the column: the frame is no wider than the window, the page has no sideways scroll, and its visible height is
  // the preview's 80vh (the frame's own height is that divided by the scale), so nothing is clipped or scrolls twice.
  const box = await page.locator("iframe").boundingBox();
  expect(box?.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(box?.height).toBeGreaterThan(viewportHeight * 0.8 - 6);
  expect(box?.height).toBeLessThanOrEqual(viewportHeight * 0.8);

  // Clicks and the keyboard still reach the page through the scaling.
  await frame.getByRole("link", { name: "Services" }).click();
  await expect(linksOff).toBeVisible();
});

test("the opening view is picked once: a window resized later keeps the view the viewer has", async ({ page }) => {
  test.skip(windowWidth(page) !== 1280, "starts from the 1280 window");
  const { frame, show } = await openHarness(page);
  await show(WIDE_ONLY);
  await expect(desktopButton(page)).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(frame.locator("body")).toBeVisible();
  await expect(desktopButton(page)).toHaveAttribute("aria-pressed", "true");
  await phoneButton(page).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(phoneButton(page)).toHaveAttribute("aria-pressed", "true");
});

test("the frame takes keyboard focus on a link in the scaled Desktop view", async ({ page }) => {
  test.skip(windowWidth(page) !== 390, "scaled in the 390 window");
  const { frame, linksOff, show } = await openHarness(page);
  await show(WIDE_ONLY);
  await desktopButton(page).click();
  await expect(frame.locator(".wide")).toBeVisible();
  await frame.getByRole("link", { name: "Services" }).focus();
  await expect(frame.getByRole("link", { name: "Services" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(linksOff).toBeVisible();
});

// Review m2: a pane that is hidden reads a column width of 0. That must not reset the scale (a 0 reading once gave scale 1, so the pane
// came back with one frame drawn 1282 px wide). The last real width stays in place.
test("a hidden pane keeps the Desktop scale it had, so showing it again does not draw a 1282 px frame", async ({ page }) => {
  const { show } = await openHarness(page);
  const narrow = windowWidth(page) < 768 ? 300 : 500; // narrower than the window, so the page itself never overflows
  await show(WIDE_ONLY);
  await desktopButton(page).click();
  await expect(desktopButton(page)).toHaveAttribute("aria-pressed", "true");
  await page.evaluate((w) => (document.getElementById("root")!.style.width = `${w}px`), narrow);
  const boxWidth = () => page.locator("iframe").evaluate((el) => (el.parentElement as HTMLElement).style.width);
  await expect.poll(boxWidth).toBe(`${narrow}px`);
  await page.evaluate(() => (document.getElementById("root")!.style.display = "none"));
  // The observer reports the 0 width before the next frame; three frames later it has certainly been handled.
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  expect(await boxWidth()).toBe(`${narrow}px`);
  await page.evaluate(() => (document.getElementById("root")!.style.display = ""));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

// Review m3: the clip box must not be a scroll container, so script cannot scroll the drawn page away from its frame.
test("the Desktop frame's clip box cannot be scrolled by script", async ({ page }) => {
  const { show } = await openHarness(page);
  const narrow = windowWidth(page) < 768 ? 300 : 500; // narrower than the window, so the page itself never overflows
  await show(WIDE_ONLY);
  await desktopButton(page).click();
  await expect(desktopButton(page)).toHaveAttribute("aria-pressed", "true");
  await page.evaluate((w) => (document.getElementById("root")!.style.width = `${w}px`), narrow);
  await expect.poll(() => page.locator("iframe").evaluate((el) => (el.parentElement as HTMLElement).style.width)).toBe(`${narrow}px`);
  const moved = await page.locator("iframe").evaluate((el) => {
    const box = el.parentElement as HTMLElement;
    box.scrollLeft = 300;
    box.scrollTop = 300;
    return { left: box.scrollLeft, top: box.scrollTop };
  });
  expect(moved).toEqual({ left: 0, top: 0 });
});
