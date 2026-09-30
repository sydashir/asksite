// Modern's layout in real browsers (Playwright's Chromium and WebKit, the repo's own installed engines), with the real
// compiled sheet: what a unit test of the markup cannot see. It pins the adversarial checks' findings (WCAG 1.4.12
// spacing, long unbroken words, odd photo counts) and the build judges' layout must-fixes (A12 Modern build, rounds 2
// and 3). No network: every photo is one gray pixel.
import { chromium, webkit, type Browser, type BrowserType, type Page } from "@playwright/test";
import { FONT_IDS, type FontId, type SiteDocumentInput } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESIGN_CSS, FIXTURE_FORM_ACTION, FIXTURES, inDesign, loadFixture, type FixtureName } from "../../../../../fixtures/index.ts";
import { render } from "../../../src/index.ts";

// The functions handed to tab.evaluate run inside the page. The root tsconfig has no DOM library (only e2e/ has
// one), so this file declares the page globals those functions use, for itself only.
declare const document: any;
declare const getComputedStyle: any;
declare const NodeFilter: any;

const GRAY = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEUlEQVR42mM4ffUhHDHg5AAASSceDT8mdlEAAAAASUVORK5CYII=", "base64");
const ENGINES: ReadonlyArray<readonly [string, BrowserType]> = [
  ["chromium", chromium],
  ["webkit", webkit],
];

/** Modern's page of `input` (in `font` when given), with the real compiled sheet. */
const pageOf = (input: SiteDocumentInput, font?: FontId): string => {
  const doc = inDesign(input, "modern");
  return render(font === undefined ? doc : { ...doc, theme: { ...doc.theme, font } }, { stylesheets: DESIGN_CSS, formAction: FIXTURE_FORM_ACTION }).html;
};
const page = (name: FixtureName, font?: FontId): string => pageOf(loadFixture(name), font);

const withFacts = (input: SiteDocumentInput, facts: Partial<SiteDocumentInput["facts"]>): SiteDocumentInput => ({ ...input, facts: { ...input.facts, ...facts } });
/** `input` with the trust section moved after services: a band of its own, and the hero keeps one short line. */
function trustLater(input: SiteDocumentInput): SiteDocumentInput {
  const trust = input.layout.filter((section) => section.id === "trust");
  const rest = input.layout.filter((section) => section.id !== "trust");
  const services = rest.findIndex((section) => section.id === "services");
  return { ...input, layout: [...rest.slice(0, services + 1), ...trust, ...rest.slice(services + 1)] };
}
/** One word of `length` letters: no break chance in it. */
const word = (length: number, first: string): string => (first + "ordwithoutabreak".repeat(6)).slice(0, length);

const plumberInput = loadFixture("plumber-austin");
const cleaningInput = loadFixture("cleaning-minimal");
/** Documents with one long unbroken word in an owner field, each at or near the schema's limit for that field. */
const LONG_WORDS: ReadonlyArray<readonly [string, SiteDocumentInput]> = [
  ["a 39-letter business name", withFacts(plumberInput, { businessName: "AustinEmergencyPlumbingAndDrainCleaning" })],
  ["a 60-letter business name", withFacts(plumberInput, { businessName: word(60, "B") })],
  ["a 30-letter license number, trust later", withFacts(loadFixture("hvac-phoenix"), { licences: [{ label: "Arizona ROC", number: "W".repeat(30) }] })],
  ["a 30-digit license number, trust later", withFacts(trustLater(plumberInput), { licences: [{ label: "Texas master plumber", number: "1".repeat(30) }] })],
  ["an 80-letter street", withFacts(plumberInput, { location: { ...plumberInput.facts.location, streetAddress: word(80, "S") } })],
  ["a 40-letter home town, no street", withFacts(plumberInput, { location: { city: word(40, "C"), state: "TX" } })],
  ["an 80-letter area note, one place", withFacts(cleaningInput, { serviceArea: { places: ["Boise"], note: word(80, "N") } })],
  ["a 40-letter place, the only one", withFacts(cleaningInput, { serviceArea: { places: [word(40, "P")] } })],
];

/** WCAG 1.4.12's values: line height 1.5, letter spacing 0.12em, word spacing 0.16em, paragraph spacing 2em. */
const TEXT_SPACING = "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }";

/**
 * Text a person can see that is cut off by a box that clips, lies past the window's right edge, or runs into other
 * text (WCAG 1.4.12 counts each as lost content); and sideways scroll. The sticky header and call bar sit over the
 * page by design, so their text is left out of the overlap check.
 */
function lostText(): string[] {
  const out: string[] = [];
  const width = document.documentElement.clientWidth;
  const sideways = document.documentElement.scrollWidth - width;
  if (sideways > 0) out.push(`sideways ${sideways}px`);
  const placed: Array<{ text: string; rects: Array<{ left: number; right: number; top: number; bottom: number }> }> = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || !(node.textContent ?? "").trim() || parent.closest(".sr-only, .hp, select, option, script, style")) continue;
    if (!parent.checkVisibility({ visibilityProperty: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects: Array<{ left: number; right: number; top: number; bottom: number }> = [...range.getClientRects()].filter((r: { width: number }) => r.width > 0.5);
    const text = (node.textContent ?? "").trim().slice(0, 24);
    for (let box = parent; box !== null && box !== document.body; box = box.parentElement) {
      const style = getComputedStyle(box);
      const clipX = style.overflowX !== "visible";
      const clipY = style.overflowY !== "visible";
      if (!clipX && !clipY) continue;
      const b = box.getBoundingClientRect();
      const cut = rects.some((r) => (clipX && (r.left < b.left - 1 || r.right > b.right + 1)) || (clipY && (r.top < b.top - 1 || r.bottom > b.bottom + 1)));
      if (cut) out.push(`cut "${text}"`);
      break;
    }
    if (rects.some((r) => r.right > width + 1)) out.push(`off the page "${text}"`);
    if (parent.closest("header, aside") === null) placed.push({ text, rects });
  }
  const meet = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  for (const [i, one] of placed.entries()) {
    const other = placed.slice(i + 1).find((two) => one.rects.some((a) => two.rects.some((b) => meet(a, b))));
    if (other !== undefined) out.push(`"${one.text}" runs into "${other.text}"`);
  }
  return [...new Set(out)];
}

describe.each(ENGINES)("Modern in %s", (engineName, engine) => {
  let browser: Browser;
  let tab: Page;
  beforeAll(async () => {
    browser = await engine.launch();
    tab = await browser.newPage();
    await tab.route(/^https?:\/\//, (route) => (route.request().resourceType() === "image" ? route.fulfill({ body: GRAY, contentType: "image/png" }) : route.abort()));
  }, 60_000);
  // Closing a browser, like launching one, can take over Vitest's 10 s hook default on a loaded machine.
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  async function open(html: string, width: number, css?: string): Promise<void> {
    await tab.setViewportSize({ width, height: 800 });
    await tab.setContent(html, { waitUntil: "load" });
    if (css !== undefined) await tab.addStyleTag({ content: css });
  }

  // attack1 I-1: the call card's number lost its last digit off the card and the page scrolled sideways, and the hours
  // board cut its time column. Today's page loses nothing on the same documents.
  it("loses no text and never scrolls sideways under WCAG 1.4.12 text spacing, on phones, for every fixture and lettering", async () => {
    const found: string[] = [];
    for (const name of FIXTURES) {
      for (const font of FONT_IDS) {
        await open(page(name, font), 320, TEXT_SPACING);
        for (const width of [320, 360, 390, 768]) {
          await tab.setViewportSize({ width, height: 800 });
          for (const problem of await tab.evaluate(lostText)) found.push(`${name} ${font} ${width}: ${problem}`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 120_000);

  it("keeps each license number in one piece on small phones, in every lettering (judge 3)", async () => {
    const found: string[] = [];
    for (const font of FONT_IDS) {
      await open(page("plumber-austin", font), 320);
      for (const width of [320, 340, 360, 390]) {
        await tab.setViewportSize({ width, height: 800 });
        // The lines the number (the text after "License ") takes, whatever markup holds it.
        const lines = await tab.evaluate(() => {
          const strong = [...document.querySelectorAll("#top .cred strong")].find((el) => el.textContent?.startsWith("License "));
          if (strong === undefined) return -1;
          const range = document.createRange();
          let seen = 0;
          const walker = document.createTreeWalker(strong, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const length = node.textContent?.length ?? 0;
            if (seen + length > "License ".length && seen <= "License ".length) range.setStart(node, "License ".length - seen);
            range.setEnd(node, length);
            seen += length;
          }
          return new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top))).size;
        });
        if (lines !== 1) found.push(`${font} ${width}: ${lines} lines`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  it("puts every price on its own line under its service's name, at every width (judge 1)", async () => {
    const found: string[] = [];
    for (const name of ["plumber-austin", "hvac-phoenix"] as const) {
      await open(page(name), 390);
      for (const width of [390, 768, 1024, 1280]) {
        await tab.setViewportSize({ width, height: 800 });
        const wrong = await tab.evaluate(() =>
          [...document.querySelectorAll("#services .card:not(.ask)")].flatMap((card) => {
            const title = card.querySelector("h3")?.getBoundingClientRect();
            const price = card.querySelector(".price")?.getBoundingClientRect();
            return title !== undefined && price !== undefined && (price.top < title.bottom - 1 || Math.abs(price.left - title.left) > 1) ? [card.querySelector("h3")?.textContent ?? ""] : [];
          }),
        );
        for (const title of wrong) found.push(`${name} ${width}: ${title}`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  it("fills the services grid's last row: the call-to-action card ends level with the grid's right edge (judges 1-3)", async () => {
    const found: string[] = [];
    // Every fixture, and 1 to 9 services in both variants (each place the card can land in rows of 2, 3 and 4).
    const roofing = inDesign(loadFixture("roofing-extreme"), "modern");
    const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((count) =>
      (["cards", "compact"] as const).map((variant): [string, string] => [
        `${count} ${variant}`,
        render(
          {
            ...roofing,
            facts: { ...roofing.facts, services: roofing.facts.services.slice(0, count) },
            copy: { ...roofing.copy, serviceDescriptions: roofing.copy.serviceDescriptions.slice(0, count) },
            layout: roofing.layout.map((s) => (s.id === "services" ? { id: "services", variant } : s)),
          } as SiteDocumentInput,
          { stylesheets: DESIGN_CSS, formAction: FIXTURE_FORM_ACTION },
        ).html,
      ]),
    );
    for (const [name, html] of [...FIXTURES.map((fixture): [string, string] => [fixture, page(fixture)]), ...counts]) {
      await open(html, 390);
      for (const width of [390, 700, 1024, 1280, 1920]) {
        await tab.setViewportSize({ width, height: 800 });
        const gap = await tab.evaluate(() => {
          const list = document.querySelector("#services .cards")?.getBoundingClientRect();
          const last = document.querySelector("#services .cards > li:last-child")?.getBoundingClientRect();
          return list === undefined || last === undefined ? -1 : Math.round(list.right - last.right);
        });
        if (Math.abs(gap) > 1) found.push(`${name} ${width}: ${gap}px short`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  it("gives the hero's two buttons one width when they stack (judge 2)", async () => {
    const found: string[] = [];
    for (const name of FIXTURES) {
      await open(page(name), 768);
      for (const width of [768, 1024, 1100, 1280]) {
        await tab.setViewportSize({ width, height: 800 });
        const [a, b] = await tab.evaluate((): Array<{ top: number; width: number }> => [...document.querySelectorAll("#top .hero-actions > a")].map((el) => el.getBoundingClientRect().toJSON()));
        if (a !== undefined && b !== undefined && Math.abs(a.top - b.top) > 1 && Math.abs(a.width - b.width) > 1) found.push(`${name} ${width}: ${Math.round(a.width)} vs ${Math.round(b.width)}`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  // Round 2's review and attack I-1: owner text in a flex row keeps its automatic minimum (its min-content), and the
  // page's overflow-wrap: break-word does not lower that, so one long word pushed the page sideways (the footer's
  // closing row, the hero's license line, the address beside its icon, the hero line's town). Today's page loses
  // nothing on the same documents.
  it("never scrolls sideways or loses text with one long unbroken owner word, in every lettering (round 2 review and attack)", async () => {
    const found: string[] = [];
    for (const [name, input] of LONG_WORDS) {
      for (const font of FONT_IDS) {
        await open(pageOf(input, font), 320);
        for (const width of [320, 360, 390, 414, 480, 600, 768, 1024, 1280, 1920]) {
          await tab.setViewportSize({ width, height: 800 });
          for (const problem of await tab.evaluate(lostText)) found.push(`${name} ${font} ${width}: ${problem}`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 180_000);

  // Round 2's review and attack I-2: the phone rule that gives an odd first photo the whole row outweighed the desktop
  // spans, so from 1024 px 3, 5 or 7 photos showed the first one alone across the row and left a hole beside the next.
  it("lays 3, 5 and 7 photos out in full rows of three from 1024 px, a short last row centred (round 2 review and attack)", async () => {
    const found: string[] = [];
    const roofing = loadFixture("roofing-extreme");
    for (const count of [3, 5, 7]) {
      await open(pageOf(withFacts(roofing, { photos: (roofing.facts.photos ?? []).slice(0, count) })), 1024);
      for (const width of [390, 1024, 1280, 1920]) {
        await tab.setViewportSize({ width, height: 800 });
        const rows = await tab.evaluate(() => {
          const list = document.querySelector("#our-work .shots").getBoundingClientRect();
          const byRow = new Map<number, Array<{ left: number; right: number; width: number }>>();
          for (const li of document.querySelectorAll("#our-work .shots > li")) {
            const box = li.getBoundingClientRect();
            byRow.set(Math.round(box.top), [...(byRow.get(Math.round(box.top)) ?? []), { left: box.left, right: box.right, width: box.width }]);
          }
          return { list: { left: list.left, right: list.right, width: list.width }, rows: [...byRow.values()] };
        });
        const cells = rows.rows.flat();
        if (width < 1024) {
          // Phones and tablets keep two columns, an odd first photo across the row.
          if (Math.abs((cells[0]?.width ?? 0) - rows.list.width) > 1) found.push(`${count} photos ${width}: the first photo is not across the row`);
          continue;
        }
        if (rows.rows.some((row, i) => row.length !== 3 && i < rows.rows.length - 1)) found.push(`${count} photos ${width}: rows ${rows.rows.map((row) => row.length).join("+")}`);
        if (cells.some((cell) => Math.abs(cell.width - (cells[0]?.width ?? 0)) > 1)) found.push(`${count} photos ${width}: widths ${cells.map((cell) => Math.round(cell.width)).join(",")}`);
        for (const row of rows.rows) {
          const before = (row[0]?.left ?? 0) - rows.list.left;
          const after = rows.list.right - (row.at(-1)?.right ?? 0);
          if (Math.abs(before - after) > 1) found.push(`${count} photos ${width}: a row of ${row.length} is off centre (${Math.round(before)} vs ${Math.round(after)} px)`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  // Round 2's judges: the stand-alone credentials band had equal columns, so "24/7 emergency service" wrapped under
  // itself while "Insured" used a third of its column, and at 1024 px one credential sat alone on a second row.
  it("sizes the stand-alone credentials band to its content: each credential on one line, none alone on a row, one gap (round 2 judges)", async () => {
    const found: string[] = [];
    const hvac = loadFixture("hvac-phoenix");
    const plumber = trustLater(loadFixture("plumber-austin"));
    const BANDS: ReadonlyArray<readonly [string, SiteDocumentInput]> = [
      ["hvac-phoenix", hvac],
      ["one license", withFacts(hvac, { licences: (hvac.facts.licences ?? []).slice(0, 1) })],
      ["three licenses", withFacts(hvac, { licences: [...(hvac.facts.licences ?? []), { label: "Arizona ROC (commercial)", number: "ROC 999003" }] })],
      ["plumber, every fact", plumber],
      ["plumber, three licenses", withFacts(plumber, { licences: [...(plumber.facts.licences ?? []), { label: "Texas backflow tester", number: "BPAT-0081122" }, { label: "Austin water utility", number: "AWU-5512" }] })],
    ];
    for (const [name, input] of BANDS) {
      for (const font of FONT_IDS) {
        await open(pageOf(input, font), 768);
        for (const width of [768, 800, 900, 1000, 1023, 1024, 1100, 1280, 1440, 1920]) {
          await tab.setViewportSize({ width, height: 800 });
          const items = await tab.evaluate(() =>
            [...document.querySelectorAll("#credentials .cred")].map((li) => {
              const range = document.createRange();
              range.selectNodeContents(li.querySelector("strong"));
              const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top))).size;
              const box = li.getBoundingClientRect();
              return { text: li.querySelector("strong").textContent, lines, top: Math.round(box.top), left: box.left, right: box.right };
            }),
          );
          const where = `${name} ${font} ${width}`;
          for (const item of items) if (item.lines !== 1) found.push(`${where}: "${item.text}" takes ${item.lines} lines`);
          const rows = [...new Set(items.map((item) => item.top))].map((top) => items.filter((item) => item.top === top));
          if (rows.length > 1 && rows.some((row) => row.length === 1)) found.push(`${where}: rows of ${rows.map((row) => row.length).join("+")}`);
          for (const row of rows) {
            for (const [i, item] of row.slice(1).entries()) {
              const gap = item.left - (row[i]?.right ?? 0);
              if (Math.abs(gap - 32) > 1) found.push(`${where}: ${Math.round(gap)} px before "${item.text}"`);
            }
          }
        }
      }
    }
    expect(found).toEqual([]);
  }, 120_000);

  // Round 2's judges: on phones and tablets the fewest-facts page stacked its no-hours card (the service area and the
  // email) under the subheadline: the town a third time on one screen, and Services pushed under the call bar. The
  // card balances the split hero, so it shows from 1024 px, beside the headline; the hours card shows everywhere.
  it("shows the fewest-facts hero card only beside the headline, from 1024 px (round 2 judges)", async () => {
    const found: string[] = [];
    const shown = () => {
      const card = document.querySelector("#top .door");
      const title = document.querySelector("#top h1").getBoundingClientRect();
      return card === null || card.getClientRects().length === 0 ? "hidden" : card.getBoundingClientRect().left > title.right ? "beside" : "under";
    };
    const { heroPhoto: _photo, ...facts } = plumberInput.facts;
    const noPhoto = { ...plumberInput, facts };
    for (const [name, html, expected] of [
      ["cleaning-minimal", page("cleaning-minimal"), (width: number) => (width < 1024 ? "hidden" : "beside")],
      ["hours, no photo", pageOf(noPhoto), (width: number) => (width < 1024 ? "under" : "beside")],
    ] as const) {
      await open(html, 390);
      for (const width of [320, 390, 768, 1023, 1024, 1280, 1920]) {
        await tab.setViewportSize({ width, height: 800 });
        const got = await tab.evaluate(shown);
        if (got !== expected(width)) found.push(`${name} ${width}: the card is ${got}`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  // Round 2's judge 3: six places used six of the board's seven columns at 1280 px, an empty column at the end.
  it("spreads a row of places across the whole board (round 2 judges)", async () => {
    const found: string[] = [];
    await open(page("hvac-phoenix"), 1280);
    for (const width of [768, 1024, 1280, 1920]) {
      await tab.setViewportSize({ width, height: 800 });
      // The widest row reaches the board's right edge: no empty column after the places.
      const gap = await tab.evaluate(() => {
        const list = document.querySelector("#service-area .places").getBoundingClientRect();
        return Math.round(list.right - Math.max(...[...document.querySelectorAll("#service-area .place")].map((place) => place.getBoundingClientRect().right)));
      });
      if (Math.abs(gap) > 1) found.push(`${width}: ${gap} px empty after the last place`);
    }
    expect(found).toEqual([]);
  }, 60_000);

  // Round 2's judges: the "From $X" pill was 3 px taller than "Price on request", so the descriptions of priced and
  // unpriced cards in one row started 3-4 px apart.
  it("gives every price line one height, so descriptions in a row of cards start on one line (round 2 judges)", async () => {
    const found: string[] = [];
    for (const name of ["plumber-austin", "hvac-phoenix"] as const) {
      for (const font of FONT_IDS) {
        await open(page(name, font), 390);
        for (const width of [390, 768, 1024, 1280, 1920]) {
          await tab.setViewportSize({ width, height: 800 });
          const cards = await tab.evaluate(() =>
            [...document.querySelectorAll("#services .card:not(.ask)")].map((card) => ({
              top: Math.round(card.getBoundingClientRect().top),
              price: card.querySelector(".price").getBoundingClientRect().height,
              desc: card.querySelector(".card-desc").getBoundingClientRect().top - card.querySelector(".price").getBoundingClientRect().top,
              start: card.querySelector(".card-desc").getBoundingClientRect().top,
            })),
          );
          const where = `${name} ${font} ${width}`;
          const heights = cards.map((card) => card.price);
          if (Math.max(...heights) - Math.min(...heights) > 0.5) found.push(`${where}: price lines ${heights.map((h) => h.toFixed(1)).join(", ")} px tall`);
          const gaps = cards.map((card) => card.desc);
          if (Math.max(...gaps) - Math.min(...gaps) > 0.5) found.push(`${where}: descriptions start ${gaps.map((g) => g.toFixed(1)).join(", ")} px under the price`);
          // From 1280 px every service name here is one line, so each row's descriptions share one line.
          if (width >= 1280) {
            for (const top of new Set(cards.map((card) => card.top))) {
              const starts = cards.filter((card) => card.top === top).map((card) => card.start);
              if (Math.max(...starts) - Math.min(...starts) > 0.5) found.push(`${where}: a row's descriptions start ${starts.map((s) => s.toFixed(1)).join(", ")}`);
            }
          }
        }
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  // Round 3: hiding the no-hours card moved the fewest-facts page up, and on the Pixel 7 the services card's button
  // then stuck out 0.4 px above the call bar, which failed the phone e2e's axe check. axe-core 4.13's target-size rule
  // (node_modules/axe-core/axe.js: targetSizeEvaluate, targetOffsetEvaluate) passes a target the bar's box wholly
  // contains; one that sticks out past the bar's top edge, or past the screen's bottom edge, passes only when the part
  // that sticks out is at least 2 x (12 px - the gap between that edge and the bar's buttons): 2 px above, 4 px below.
  // At the e2e phone windows every tap target keeps 3 px clear of those bands, so a sub-pixel change in a font or an
  // engine cannot flip the check.
  it("leaves no tap target half under the call bar on the e2e phone windows (axe target-size, round 3)", async () => {
    const found: string[] = [];
    // The phone e2e projects: chromium-390 and Pixel 7; webkit-390 and iPhone 13 (playwright.config.ts).
    const windows = engineName === "chromium" ? [[390, 900], [412, 839]] : [[390, 844], [390, 664]];
    const halfUnder = () => {
      const bar = document.querySelector("aside").getBoundingClientRect();
      const buttons = document.querySelector("aside a").getBoundingClientRect();
      const above = 2 * (12 - (buttons.top - bar.top)) + 3;
      const below = 2 * (12 - (bar.bottom - buttons.bottom)) + 3;
      const out: string[] = [];
      for (const target of document.querySelectorAll("a, button, summary, input, select, textarea")) {
        const box = target.getBoundingClientRect();
        if (target.closest("aside") !== null || box.height === 0) continue;
        // How far the target sticks out above the bar, and past the screen's bottom (negative: it stays inside).
        const up = bar.top - box.top;
        const down = box.bottom - bar.bottom;
        if ((up > -3 && up < above && box.bottom > bar.top) || (down > -3 && down < below && box.top < bar.bottom)) {
          out.push(`"${target.textContent.trim().slice(0, 20)}" sticks out ${up.toFixed(1)} px above the bar, ${down.toFixed(1)} px below the screen`);
        }
      }
      return out;
    };
    for (const name of FIXTURES) {
      await open(page(name), 390);
      for (const [width, height] of windows) {
        await tab.setViewportSize({ width: width!, height: height! });
        for (const problem of await tab.evaluate(halfUnder)) found.push(`${name} ${width}x${height}: ${problem}`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);
});
