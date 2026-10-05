// What a visitor sees on Bold's built pages, measured in real browsers (A16 round 6): the first screen of every page
// offers one quote label only (the moderator's quote rule, 2026-10-05); on iPad landscape widths the /contact form
// keeps Send request in the first screen with "Choose a service" whole, and its head keeps the owner's standing on one
// line; on iPad portrait widths the footer's credentials sit right under the business name; at 320 px every page, in
// each of the three letterings, reflows with no text lost, and so does every page at 320-430 px with bigger text (root
// font-size 125%); and on /contact a licence number that fits on one line is never split.
// Every fixture's whole Bold site with the real Bold sheet, served from memory on its own origin (Playwright 1.63
// BrowserContext.route and Route.fulfill; photos are a gray tile, anything else is aborted), in Chromium and WebKit.
// The pages run no JavaScript; the checks are script text, since the renderer's TypeScript program has no DOM types.
import { chromium, webkit, type Browser, type Page } from "@playwright/test";
import { FONT_IDS, PAGES, type PageId } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESIGN_CSS, FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, FIXTURES, inDesign, loadFixture, renderFixture, type FixtureName } from "../../../../../fixtures/index.ts";
import { render, type RenderedSitePage } from "../../../src/render.ts";

const GRAY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEUlEQVR42mM4ffUhHDHg5AAASSceDT8mdlEAAAAASUVORK5CYII=", "base64");
const SITES = new Map(FIXTURES.map((name) => [name, renderFixture(name, DESIGN_CSS, "impact")]));
const pagesOf = (name: FixtureName): readonly PageId[] => (SITES.get(name) ?? []).map((p) => p.page);
/** Every fixture's site again in each lettering the owner can pick (theme.font), served as "<fixture>-<font>". */
const LETTERINGS = FIXTURES.flatMap((name) =>
  FONT_IDS.map((font) => {
    const doc = inDesign(loadFixture(name), "impact");
    const { pages } = render({ ...doc, theme: { ...doc.theme, font } }, { stylesheets: DESIGN_CSS, formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL });
    return { name, font, site: `${name}-${font}`, pages };
  }),
);
const SERVED = new Map<string, readonly RenderedSitePage[]>([...SITES, ...LETTERINGS.map(({ site, pages }) => [site, pages] as const)]);
const origin = (site: string) => `https://${site}.bold.invalid`;

type Size = readonly [width: number, height: number];
const ENGINES = { Chromium: chromium, WebKit: webkit } as const;
const browsers = new Map<keyof typeof ENGINES, Browser>();

beforeAll(async () => {
  for (const [label, engine] of Object.entries(ENGINES)) browsers.set(label as keyof typeof ENGINES, await engine.launch());
}, 60_000);
afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
}, 60_000);

/** A window of `size` in `engine` that serves every site's pages; `visit` opens one and runs `script` once its fonts are ready. */
async function inWindow(engine: keyof typeof ENGINES, [width, height]: Size, body: (visit: <T>(site: string, path: string, script: string) => Promise<T>) => Promise<void>): Promise<void> {
  const browser = browsers.get(engine);
  if (browser === undefined) throw new Error(`${engine} did not start`);
  const context = await browser.newContext({ viewport: { width, height } });
  try {
    await context.route(/^https?:\/\//, (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const site = [...SERVED.keys()].find((s) => origin(s) === url.origin);
      const found = site === undefined || request.method() !== "GET" ? undefined : SERVED.get(site)?.find((p) => p.path === url.pathname);
      if (found !== undefined) return route.fulfill({ body: found.html, contentType: "text/html; charset=utf-8" });
      if (request.resourceType() === "image") return route.fulfill({ body: GRAY_PNG, contentType: "image/png" });
      return route.abort();
    });
    const page: Page = await context.newPage();
    await body(async <T,>(site: string, path: string, script: string) => {
      await page.goto(origin(site) + path, { waitUntil: "load" });
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

/**
 * What a visitor loses at the window's width: the page scrolling sideways (WCAG 1.4.10), and each visible text node
 * that a box with clipping overflow cuts (any box up to <body>, in the direction it clips) or that runs past the right
 * edge of the page. Screen-reader-only text, the honeypot and the select's options do not count, nor does text whose
 * element is not rendered or is visibility:hidden.
 */
const LOST_TEXT = `(() => {
  const lost = [];
  const root = document.documentElement, width = root.clientWidth;
  if (root.scrollWidth > width) lost.push("scrolls " + (root.scrollWidth - width) + " px sideways");
  const name = (el) => el.tagName.toLowerCase() + [...el.classList].map((c) => "." + c).join("");
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || node.data.trim() === "" || parent.closest(".sr-only, .hp, select, script, style") !== null) continue;
    if (!parent.checkVisibility({ visibilityProperty: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const lines = [...range.getClientRects()].filter((r) => r.width > 0.5);
    const text = JSON.stringify(node.data.trim().replace(/\\s+/g, " ").slice(0, 32));
    if (lines.some((r) => r.right > width + 1)) lost.push(text + " runs past the right edge");
    for (let box = parent; box !== root; box = box.parentElement) {
      const style = getComputedStyle(box);
      const clipX = style.overflowX !== "visible", clipY = style.overflowY !== "visible";
      if (!clipX && !clipY) continue;
      const b = box.getBoundingClientRect();
      if (lines.some((r) => (clipX && (r.left < b.left - 1 || r.right > b.right + 1)) || (clipY && (r.top < b.top - 1 || r.bottom > b.bottom + 1)))) lost.push(text + " is cut by " + name(box));
    }
  }
  return [...new Set(lost)];
})()`;

/**
 * Opens every <details> but the phone menu (open, it hides the page), so the text a tap reveals is checked too: the
 * FAQ answers, the hero's other licences, the other reviews and areas. The FAQ is an exclusive accordion (name="faq")
 * that keeps one answer open, so each loses its name first.
 */
const OPEN_DETAILS = `for (const details of document.querySelectorAll("details:not(.menu)")) {
  details.removeAttribute("name");
  details.open = true;
}`;

/** The bigger-default-text setting: the root font-size at 125%. */
const BIGGER_TEXT = `document.documentElement.style.setProperty("font-size", "125%", "important");`;

/**
 * Each licence number in the /contact list that is split over lines although it fits on a line of its own (round 5's
 * rule: a number moves to the next line whole, and breaks inside only when it alone is wider than the line). Its lines
 * come from each character's top; its whole width from an unwrapped copy in the same line box; the line from its text's
 * box (the list item's span beside the icon).
 */
const SPLIT_LICENCES = `[...document.querySelectorAll(".talk-lics .lic-num")].flatMap((number) => {
  const text = number.firstChild, line = number.closest("li > span");
  const copy = number.cloneNode(true);
  copy.style.cssText = "position:absolute;display:inline;max-width:none;white-space:nowrap";
  line.append(copy);
  const whole = copy.getBoundingClientRect().width;
  copy.remove();
  const room = line.getBoundingClientRect().width;
  const pieces = [];
  for (let i = 0, top = null; i < text.length; i++) {
    const range = document.createRange();
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    const at = Math.round(range.getBoundingClientRect().top);
    if (at !== top) pieces.push("");
    pieces[pieces.length - 1] += text.data[i];
    top = at;
  }
  return pieces.length > 1 && whole <= room ? [JSON.stringify(text.data) + " splits as " + pieces.map((p) => JSON.stringify(p)).join(" / ") + " though it fits (" + whole.toFixed(2) + " px on a " + room.toFixed(2) + " px line)"] : [];
})`;

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

// The checks above render each fixture in its own lettering only, so they never saw roofing-extreme's /contact licences
// push the page 12 px sideways at 320 px in the wider "clean" and "sturdy" letterings (moderator's probe, 2026-10-05).
// Every page of every fixture in each lettering, at the narrowest phone width (A12 section 13; WCAG 1.4.10), with every
// <details> but the menu open (moderator ruling, 2026-10-05).
describe.each(Object.keys(ENGINES) as Array<keyof typeof ENGINES>)("Bold's pages at 320 px in %s", (engine) => {
  it("keep every page of every fixture, in each lettering, within the window with no text cut or past its right edge", async () => {
    const wrong: string[] = [];
    await inWindow(engine, [320, 568], async (visit) => {
      for (const { name, font, site, pages } of LETTERINGS) {
        for (const { path } of pages) {
          for (const problem of await visit<string[]>(site, path, `(() => { ${OPEN_DETAILS} return ${LOST_TEXT}; })()`)) wrong.push(`${name} in ${font} ${path}: ${problem}`);
        }
      }
    });
    expect(wrong).toEqual([]);
  }, 180_000);
});

// The bigger-default-text setting (root font-size 125%) pushed the call bar's "Get a quote" past the right edge and
// the page sideways at 320-375 px (moderator's probe, 2026-10-05). Every page of every fixture in each lettering, at
// the phone widths, with every <details> but the menu open (WCAG 1.4.4 and 1.4.10).
const BIGGER_TEXT_WIDTHS = [320, 340, 360, 375, 390, 400, 414, 430] as const;
describe.each(Object.keys(ENGINES) as Array<keyof typeof ENGINES>)("Bold's pages with bigger text in %s", (engine) => {
  it(`keep every page of every fixture, in each lettering, at root font-size 125% and ${BIGGER_TEXT_WIDTHS.join(", ")} px, within the window with no text cut or past its right edge`, async () => {
    const wrong: string[] = [];
    for (const width of BIGGER_TEXT_WIDTHS) {
      await inWindow(engine, [width, 800], async (visit) => {
        for (const { name, font, site, pages } of LETTERINGS) {
          for (const { path } of pages) {
            for (const problem of await visit<string[]>(site, path, `(() => { ${BIGGER_TEXT} ${OPEN_DETAILS} return ${LOST_TEXT}; })()`)) wrong.push(`${name} in ${font} ${path} at ${width}: ${problem}`);
          }
        }
      });
    }
    expect(wrong).toEqual([]);
  }, 600_000);
});

// Round 5's rule held in the hero and the footer but not in the /contact licence list, where roofing-extreme's
// "RCAT-…" split at its hyphen and electrical-xss's number after "</style>" while each fitted on a line of its own
// (continuation 3's measurement). /contact of every fixture in each lettering, phone to wide desktop.
const LICENCE_WIDTHS = [336, 348, 390, 400, 484, 652, 1024, 1120, 1280, 1920] as const;
describe.each(Object.keys(ENGINES) as Array<keyof typeof ENGINES>)("Bold's /contact licences in %s", (engine) => {
  it(`never split a licence number that fits on one line, on /contact of every fixture in each lettering at ${LICENCE_WIDTHS.join(", ")} px`, async () => {
    const wrong: string[] = [];
    for (const width of LICENCE_WIDTHS) {
      await inWindow(engine, [width, 800], async (visit) => {
        for (const { name, font, site } of LETTERINGS) {
          for (const split of await visit<string[]>(site, "/contact", SPLIT_LICENCES)) wrong.push(`${name} in ${font} at ${width}: ${split}`);
        }
      });
    }
    expect(wrong).toEqual([]);
  }, 180_000);
});
