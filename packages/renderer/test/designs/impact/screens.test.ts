// What a visitor sees on Bold's built pages, measured in real browsers (A16 round 6): the first screen of every page
// offers one quote label only (the moderator's quote rule, 2026-10-05); on iPad landscape widths the /contact form
// keeps Send request in the first screen with "Choose a service" whole, and its head keeps the owner's standing on one
// line; on iPad portrait widths the footer's credentials sit right under the business name.
// Every fixture's whole Bold site with the real Bold sheet, served from memory on its own origin (Playwright 1.63
// BrowserContext.route and Route.fulfill; photos are a gray tile, anything else is aborted), in Chromium and WebKit.
// The pages run no JavaScript; the checks are script text, since the renderer's TypeScript program has no DOM types.
import { chromium, webkit, type Browser, type Page } from "@playwright/test";
import { PAGES, type PageId } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESIGN_CSS, FIXTURES, renderFixture, type FixtureName } from "../../../../../fixtures/index.ts";

const GRAY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEUlEQVR42mM4ffUhHDHg5AAASSceDT8mdlEAAAAASUVORK5CYII=", "base64");
const SITES = new Map(FIXTURES.map((name) => [name, renderFixture(name, DESIGN_CSS, "impact")]));
const pagesOf = (name: FixtureName): readonly PageId[] => (SITES.get(name) ?? []).map((p) => p.page);
const origin = (name: FixtureName) => `https://${name}.bold.invalid`;

type Size = readonly [width: number, height: number];
const ENGINES = { Chromium: chromium, WebKit: webkit } as const;
const browsers = new Map<keyof typeof ENGINES, Browser>();

beforeAll(async () => {
  for (const [label, engine] of Object.entries(ENGINES)) browsers.set(label as keyof typeof ENGINES, await engine.launch());
}, 60_000);
afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
}, 60_000);

/** A window of `size` in `engine` that serves every fixture's pages; `visit` opens one and runs `script` once its fonts are ready. */
async function inWindow(engine: keyof typeof ENGINES, [width, height]: Size, body: (visit: <T>(name: FixtureName, path: string, script: string) => Promise<T>) => Promise<void>): Promise<void> {
  const browser = browsers.get(engine);
  if (browser === undefined) throw new Error(`${engine} did not start`);
  const context = await browser.newContext({ viewport: { width, height } });
  try {
    await context.route(/^https?:\/\//, (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const name = FIXTURES.find((n) => origin(n) === url.origin);
      const found = name === undefined || request.method() !== "GET" ? undefined : SITES.get(name)?.find((p) => p.path === url.pathname);
      if (found !== undefined) return route.fulfill({ body: found.html, contentType: "text/html; charset=utf-8" });
      if (request.resourceType() === "image") return route.fulfill({ body: GRAY_PNG, contentType: "image/png" });
      return route.abort();
    });
    const page: Page = await context.newPage();
    await body(async <T,>(name: FixtureName, path: string, script: string) => {
      await page.goto(origin(name) + path, { waitUntil: "load" });
      await page.evaluate("document.fonts.ready");
      return page.evaluate<T>(script);
    });
  } finally {
    await context.close();
  }
}

/**
 * The words of each site-level quote action a visitor sees in the first screen: every link to the form that is
 * rendered (not display:none, not visibility:hidden) and meets the window, except a service's own "Ask for a price" /
 * "Free estimate" (a contextual per-item link). The header's and the hero's button, the services card's, the closing
 * band's and the call bar's all count.
 */
const QUOTE_LABELS = `[...document.querySelectorAll('a[href="/contact#quote"]')].flatMap((a) => {
  if (a.matches(".svc-ask") || a.getClientRects().length === 0 || getComputedStyle(a).visibility === "hidden") return [];
  const box = a.getBoundingClientRect();
  if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return [];
  return [a.textContent.replace(/\\s+/g, " ").trim()];
}).filter((label, i, all) => all.indexOf(label) === i)`;

describe.each(Object.keys(ENGINES) as Array<keyof typeof ENGINES>)("Bold's first screens in %s", (engine) => {
  // The quote rule: on every page but Contact (the form is its first screen), at least one site-level quote action shows
  // and all of them carry one label: the owner's words where the call bar is hidden (from 64rem), the bar's fixed
  // "Get a quote" alone below, phones held sideways (844x390, 932x430, 915x412) included.
  it.each([[390, 844], [768, 1024], [900, 800], [1023, 768], [1280, 800], [844, 390], [932, 430], [915, 412]] as const)("shows exactly one quote label in the first screen of every page but Contact at %dx%d", async (width, height) => {
    const wrong: string[] = [];
    await inWindow(engine, [width, height], async (visit) => {
      for (const name of FIXTURES) {
        for (const id of pagesOf(name).filter((p) => p !== "contact")) {
          const labels = await visit<string[]>(name, PAGES[id].path, QUOTE_LABELS);
          if (labels.length !== 1) wrong.push(`${name} ${PAGES[id].path}: ${JSON.stringify(labels)}`);
        }
      }
    });
    expect(wrong).toEqual([]);
  });

  // Round 6 (A16 judges): from 64 to 80rem the form took a row per field and pushed Send request below the first screen
  // at 1024x768 (and across its bottom edge up to 1279 px). Name and Phone share a row again; the select keeps a whole row
  // where a half row would cut "Choose a service".
  it.each([[1024, 768], [1100, 800], [1180, 820], [1279, 800]] as const)("keeps Name | Phone on one row and Send request wholly in the first screen of /contact and /contact#quote at %dx%d, with 'Choose a service' whole", async (width, height) => {
    const wrong: string[] = [];
    await inWindow(engine, [width, height], async (visit) => {
      for (const name of FIXTURES) {
        for (const hash of ["", "#quote"]) {
          const at = `${name} /contact${hash}`;
          const form = await visit<{ opens: boolean; send: [number, number]; sideBySide: boolean; fits: boolean }>(
            name,
            `/contact${hash}`,
            `(() => {
              const box = (selector) => document.querySelector(selector).getBoundingClientRect();
              const send = box('#quote button[type="submit"]'), nameBox = box("#contact-name"), phone = box("#contact-phone");
              const select = document.querySelector("#contact-service");
              const style = getComputedStyle(select);
              const pen = document.createElement("canvas").getContext("2d");
              pen.font = style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
              const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
              return {
                opens: document.querySelector("main > section").id === "contact",
                send: [send.top, send.bottom],
                sideBySide: Math.abs(nameBox.top - phone.top) < 1 && phone.left >= nameBox.right,
                fits: pen.measureText(select.options[0].text).width <= room,
              };
            })()`,
          );
          // The owner may put the service area first (U1): Send is then further down, and only the #quote landing counts.
          if ((form.opens || hash !== "") && (form.send[0] < 0 || form.send[1] > height)) wrong.push(`${at}: Send at ${form.send.map(Math.round).join("-")} of ${height}`);
          if (!form.sideBySide) wrong.push(`${at}: Name and Phone on separate rows`);
          if (!form.fits) wrong.push(`${at}: "Choose a service" is cut`);
        }
      }
    });
    expect(wrong).toEqual([]);
  });

  // Round 6 (A16 judges): at 1024x768 (and in WebKit up to about 1100 px) "Since 1998" sat alone on a second row.
  it.each([[1024, 768], [1100, 800], [1180, 820], [1279, 800]] as const)("keeps the owner's standing on one line in the /contact head at %dx%d", async (width, height) => {
    const wrong: string[] = [];
    await inWindow(engine, [width, height], async (visit) => {
      for (const name of FIXTURES) {
        const rows = await visit<number>(name, "/contact", `new Set([...document.querySelectorAll(".ph-chips .chip")].map((c) => Math.round(c.getBoundingClientRect().top))).size`);
        if (rows > 1) wrong.push(`${name}: ${rows} rows of chips`);
      }
    });
    expect(wrong).toEqual([]);
  });

  // Round 6 (A16 judges): from 48 to 64rem the credentials dropped below the tallest column (contact and hours), about
  // 250 px under the business name. They now sit right under it, one row gap down, in its column.
  it.each([[768, 1024], [900, 800], [1023, 768]] as const)("puts the footer's credentials right under the business name at %dx%d", async (width, height) => {
    const wrong: string[] = [];
    await inWindow(engine, [width, height], async (visit) => {
      for (const name of FIXTURES) {
        const foot = await visit<{ under: number; gap: number; sameColumn: boolean } | null>(
          name,
          "/",
          `(() => {
            const grid = document.querySelector(".foot-grid");
            const [brand, , , credentials] = grid.children;
            if (credentials === undefined) return null;
            // The name's own last line (its grid cell stretches to the row's height).
            const name = brand.lastElementChild.getBoundingClientRect(), box = credentials.getBoundingClientRect();
            return { under: box.top - name.bottom, gap: parseFloat(getComputedStyle(grid).rowGap), sameColumn: Math.abs(box.left - name.left) < 1 };
          })()`,
        );
        if (foot !== null && (foot.under > foot.gap + 1 || !foot.sameColumn)) wrong.push(`${name}: credentials ${Math.round(foot.under)} px under the name (row gap ${foot.gap}), same column ${foot.sameColumn}`);
      }
    });
    expect(wrong).toEqual([]);
  });
});
