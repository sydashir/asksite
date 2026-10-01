// Modern's layout in real browsers (Playwright's Chromium and WebKit, the repo's own installed engines), with the real
// compiled sheet: what a unit test of the markup cannot see. It pins the adversarial checks' findings (WCAG 1.4.12
// spacing, long unbroken words, odd photo counts) and the build judges' layout must-fixes (A12 Modern build, rounds 2
// and 3). No network: every photo is one gray pixel.
import { chromium, webkit, type Browser, type BrowserType, type Page } from "@playwright/test";
import { FONT_IDS, type FontId, type PageId, type SiteDocumentInput } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESIGN_CSS, FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, FIXTURES, inDesign, loadFixture, type FixtureName } from "../../../../../fixtures/index.ts";
import { render } from "../../../src/index.ts";

// The functions handed to tab.evaluate run inside the page. The root tsconfig has no DOM library (only e2e/ has
// one), so this file declares the page globals those functions use, for itself only.
declare const document: any;
declare const getComputedStyle: any;
declare const NodeFilter: any;
declare const window: any;

const GRAY = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEUlEQVR42mM4ffUhHDHg5AAASSceDT8mdlEAAAAASUVORK5CYII=", "base64");
const ENGINES: ReadonlyArray<readonly [string, BrowserType]> = [
  ["chromium", chromium],
  ["webkit", webkit],
];

const OPTIONS = { stylesheets: DESIGN_CSS, formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL };
/** Modern's pages of `input` (in `font` when given), with the real compiled sheet, Home first. */
const pagesOf = (input: SiteDocumentInput, font?: FontId) => {
  const doc = inDesign(input, "modern");
  return render(font === undefined ? doc : { ...doc, theme: { ...doc.theme, font } }, OPTIONS).pages;
};
/** One of Modern's pages of `input` (Home unless another is named). */
const pageOf = (input: SiteDocumentInput, font?: FontId, id: PageId = "home"): string => pagesOf(input, font).find((p) => p.page === id)?.html ?? "";
const page = (name: FixtureName, font?: FontId, id: PageId = "home"): string => pageOf(loadFixture(name), font, id);

const withFacts = (input: SiteDocumentInput, facts: Partial<SiteDocumentInput["facts"]>): SiteDocumentInput => ({ ...input, facts: { ...input.facts, ...facts } });
/** `input` with the trust section moved after the reviews (the owner's order on Home): a band of its own, and the hero keeps one short line. */
function trustLater(input: SiteDocumentInput): SiteDocumentInput {
  const trust = input.layout.filter((section) => section.id === "trust");
  const rest = input.layout.filter((section) => section.id !== "trust");
  const reviews = rest.findIndex((section) => section.id === "testimonials");
  return { ...input, layout: [...rest.slice(0, reviews + 1), ...trust, ...rest.slice(reviews + 1)] };
}
/** One word of `length` letters: no break chance in it. */
const word = (length: number, first: string): string => (first + "ordwithoutabreak".repeat(6)).slice(0, length);

const plumberInput = loadFixture("plumber-austin");
const cleaningInput = loadFixture("cleaning-minimal");
/** Documents with one long unbroken word in an owner field, each at or near the schema's limit for that field. */
const LONG_WORDS: ReadonlyArray<readonly [string, SiteDocumentInput]> = [
  ["a 39-letter business name", withFacts(plumberInput, { businessName: "AustinEmergencyPlumbingAndDrainCleaning" })],
  ["a 60-letter business name", withFacts(plumberInput, { businessName: word(60, "B") })],
  ["a 30-letter license number, trust later", withFacts(trustLater(loadFixture("hvac-phoenix")), { licences: [{ label: "Arizona ROC", number: "W".repeat(30) }] })],
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

describe.each(ENGINES)("Modern in %s", (_engine, engine) => {
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
  it("loses no text and never scrolls sideways under WCAG 1.4.12 text spacing, on phones, on every page of every fixture, in every lettering", async () => {
    const found: string[] = [];
    for (const name of FIXTURES) {
      for (const font of FONT_IDS) {
        for (const { page: id, html } of pagesOf(loadFixture(name), font)) {
          await open(html, 320, TEXT_SPACING);
          for (const width of [320, 360, 390, 768]) {
            await tab.setViewportSize({ width, height: 800 });
            for (const problem of await tab.evaluate(lostText)) found.push(`${name} ${id} ${font} ${width}: ${problem}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  }, 300_000);

  // A16 gate: reflow from 320 to 1920 px on every page, the 1024-1079 px band (where the header turns to inline links)
  // included. Each fixture keeps its own lettering; together they use all three.
  it("never scrolls sideways or loses text on any page of any fixture from 320 to 1920 px, 1024-1079 px included", async () => {
    const found: string[] = [];
    for (const name of FIXTURES) {
      for (const { page: id, html } of pagesOf(loadFixture(name))) {
        await open(html, 320);
        for (const width of [320, 414, 600, 768, 900, 1023, 1024, 1040, 1060, 1079, 1080, 1199, 1280, 1440, 1920]) {
          await tab.setViewportSize({ width, height: 800 });
          for (const problem of await tab.evaluate(lostText)) found.push(`${name} ${id} ${width}: ${problem}`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 300_000);

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
      await open(page(name, undefined, "services"), 390);
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
          OPTIONS,
        ).pages.find((p) => p.page === "services")?.html ?? "",
      ]),
    );
    for (const [name, html] of [...FIXTURES.map((fixture): [string, string] => [fixture, page(fixture, undefined, "services")]), ...counts]) {
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
      await open(pageOf(withFacts(roofing, { photos: (roofing.facts.photos ?? []).slice(0, count) }), undefined, "gallery"), 1024);
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
    const hvac = trustLater(loadFixture("hvac-phoenix"));
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

  // Round 3's mutants: a group too wide for one row (five licenses) must wrap inside its own list; a list that did not
  // would run past the band's edge. Each credential still keeps its text on one line.
  it("wraps a group of credentials too wide for one row inside the band: five licenses (round 3)", async () => {
    const found: string[] = [];
    const hvac = trustLater(loadFixture("hvac-phoenix"));
    const five = withFacts(hvac, {
      licences: [
        ...(hvac.facts.licences ?? []),
        { label: "Arizona ROC (commercial)", number: "ROC 999003" },
        { label: "City of Phoenix", number: "MECH-20417" },
        { label: "Maricopa County", number: "MC-88120" },
      ],
    });
    for (const font of FONT_IDS) {
      await open(pageOf(five, font), 768);
      for (const width of [768, 1024, 1280, 1920]) {
        await tab.setViewportSize({ width, height: 800 });
        const outside = await tab.evaluate(() => {
          const band = document.querySelector("#credentials .creds").getBoundingClientRect();
          const lines = (li: any) => {
            const range = document.createRange();
            range.selectNodeContents(li.querySelector("strong"));
            return new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top))).size;
          };
          return [...document.querySelectorAll("#credentials .cred")]
            .filter((li) => li.getBoundingClientRect().right > band.right + 1 || lines(li) !== 1)
            .map((li) => li.querySelector("strong").textContent);
        });
        for (const text of outside) found.push(`${font} ${width}: "${text}" runs past the band or onto two lines`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

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
    await open(page("hvac-phoenix", undefined, "contact"), 1280);
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
        await open(page(name, font, "services"), 390);
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
  // then stuck out 0.4 px above the call bar, which failed the phone e2e's axe check (target-size). axe-core 4.13
  // (node_modules/axe-core/axe.js: targetSizeEvaluate, targetOffsetEvaluate, getOffset) passes a target the bar's box
  // wholly contains. A target that sticks out past the bar's top edge, or past the screen's bottom edge, is measured
  // on the part that sticks out, which passes when its centre is at least 12 px from the bar's buttons: so it can fail
  // only while the buttons sit less than 12 px from that edge (the bar had 11 px above them and 10 px below; today's
  // page has 13 and 12). With 12 px or more on both sides, no button the bar half-covers can fail, wherever the page
  // puts it, at any phone size.
  it("keeps the call bar's buttons 12 px from its top edge and from the screen's bottom edge (axe target-size, round 3)", async () => {
    const found: string[] = [];
    const gaps = () => {
      const bar = document.querySelector("aside").getBoundingClientRect();
      return [...document.querySelectorAll("aside a")].map((link) => {
        const box = link.getBoundingClientRect();
        return { text: link.textContent.trim().slice(0, 20), top: box.top - bar.top, bottom: bar.bottom - box.bottom };
      });
    };
    for (const name of FIXTURES) {
      await open(page(name), 390);
      for (const [width, height] of [[320, 568], [360, 740], [390, 664], [390, 844], [412, 839], [767, 1024]]) {
        await tab.setViewportSize({ width: width!, height: height! });
        for (const gap of await tab.evaluate(gaps)) {
          if (gap.top < 12 || gap.bottom < 12) found.push(`${name} ${width}x${height}: "${gap.text}" ${gap.top.toFixed(1)} px under the bar's top, ${gap.bottom.toFixed(1)} px over the screen's bottom`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 60_000);
  // Round 3's judge 2: on 360-376 px phones "Monday – Friday" wrapped after its dash, on the hours board and in the
  // no-photo hero's hours card. A day range now keeps its line at every phone width; a time may wrap after its dash.
  it("keeps every day range of the hours on one line on phones, on Contact and in the no-photo hero card (round 3 judges)", async () => {
    const found: string[] = [];
    const days = () =>
      [...document.querySelectorAll(".hours th")].flatMap((th) => {
        const range = document.createRange();
        range.selectNodeContents(th);
        const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top))).size;
        return lines === 1 ? [] : [th.textContent];
      });
    const { heroPhoto: _photo, ...facts } = loadFixture("hvac-phoenix").facts;
    const PLACES: ReadonlyArray<readonly [string, SiteDocumentInput, PageId]> = [
      ["plumber-austin contact", loadFixture("plumber-austin"), "contact"],
      ["hvac-phoenix contact", loadFixture("hvac-phoenix"), "contact"],
      ["hvac-phoenix home (no photo)", { ...loadFixture("hvac-phoenix"), facts }, "home"],
    ];
    for (const [name, input, id] of PLACES) {
      for (const font of FONT_IDS) {
        await open(pageOf(input, font, id), 320);
        for (const width of [320, 340, 360, 375, 390, 414, 430]) {
          await tab.setViewportSize({ width, height: 800 });
          for (const day of await tab.evaluate(days)) found.push(`${name} ${font} ${width}: "${day}" wraps`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  // Round 3's judge 2: from 768 to 928 px the footer's narrow Contact column broke a 34-character email in two
  // ("office@reliablerooter" + ".example.com"), and at 1024-1056 px the Contact page's call card did too.
  it("keeps a 34-character email and every phone number on one line from 768 to 1440 px, in the footer and the call card (round 3 judges)", async () => {
    const found: string[] = [];
    const broken = () =>
      [...document.querySelectorAll('footer a[href^="mailto:"], footer a[href^="tel:"], .call-card a[href^="mailto:"]')].flatMap((link) => {
        const range = document.createRange();
        range.selectNodeContents(link);
        return new Set([...range.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top))).size === 1 ? [] : [link.textContent];
      });
    for (const font of FONT_IDS) {
      await open(page("plumber-austin", font, "contact"), 768);
      for (let width = 768; width <= 1440; width += 16) {
        await tab.setViewportSize({ width, height: 800 });
        for (const text of await tab.evaluate(broken)) found.push(`${font} ${width}: "${text}" breaks`);
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  // Round 3's judge 1: four photos showed as two rows of two at about 588 px each from 1024 px, a section taller than
  // six photos make. From 1024 px they are one large photo beside three, no taller than the six-photo gallery.
  it("lays four photos out as one large beside three from 1024 px, no taller than six photos (round 3 judges)", async () => {
    const found: string[] = [];
    const roofing = loadFixture("roofing-extreme");
    const gallery = (count: number) => pageOf(withFacts(roofing, { photos: (roofing.facts.photos ?? []).slice(0, count) }), undefined, "gallery");
    const measure = () => {
      const cells = [...document.querySelectorAll("#our-work .shots > li")].map((li) => li.getBoundingClientRect());
      return { height: document.querySelector("#our-work .shots").getBoundingClientRect().height, widths: cells.map((c) => Math.round(c.width)), tops: cells.map((c) => Math.round(c.top)) };
    };
    for (const width of [1024, 1280, 1920]) {
      await open(gallery(6), width);
      const six = await tab.evaluate(measure);
      await open(gallery(4), width);
      const four = await tab.evaluate(measure);
      const [large, second, third, wide] = four.widths;
      if (four.height > six.height + 1) found.push(`${width}: four photos ${Math.round(four.height)} px tall, six ${Math.round(six.height)}`);
      if (!(large! > 1.9 * second! && Math.abs(second! - third!) <= 1 && Math.abs(wide! - large!) <= 1 && four.tops[1] === four.tops[0] && four.tops[3]! > four.tops[1]!)) found.push(`${width}: cells ${four.widths.join(",")} at ${four.tops.join(",")}`);
    }
    expect(found).toEqual([]);
  }, 60_000);

  // A16: every page is reachable from the header at every width (WCAG 2.4.5): inline from 1024 px, beside the name and
  // the Call button without touching them, also for the longest business name; below that through the menu.
  it("shows every page link in the header from 1024 px without touching the name or the Call button, in every lettering", async () => {
    const found: string[] = [];
    const header = () => {
      const box = (el: any) => el.getBoundingClientRect();
      const links = [...document.querySelectorAll(".nav-links a")].filter((a) => a.getClientRects().length > 0).map(box);
      const brand = box(document.querySelector(".brand"));
      const call = box(document.querySelector(".hdr-call"));
      const nav = box(document.querySelector(".nav-links"));
      return { shown: links.length, total: document.querySelectorAll(".nav-links a").length, clear: brand.right <= nav.left && nav.right <= call.left, menu: document.querySelector(".menu").getClientRects().length };
    };
    for (const name of ["plumber-austin", "roofing-extreme"] as const) {
      for (const font of FONT_IDS) {
        await open(page(name, font, "services"), 1024);
        for (const width of [1024, 1100, 1199, 1280, 1920]) {
          await tab.setViewportSize({ width, height: 800 });
          const got = await tab.evaluate(header);
          if (got.shown !== got.total || !got.clear || got.menu !== 0) found.push(`${name} ${font} ${width}: ${JSON.stringify(got)}`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 60_000);

  // A16: "Get a quote" lands on the form on the Contact page with its first field in view, below the sticky header.
  it("lands /contact#quote with the Name field in view under the header, on phones and desktops", async () => {
    const found: string[] = [];
    const contact = page("plumber-austin", undefined, "contact");
    for (const [width, height] of [[390, 664], [768, 1024], [1280, 800], [1920, 1080]] as const) {
      await tab.setViewportSize({ width, height });
      await tab.route("https://fixture.asksite.example/contact", (route) => route.fulfill({ body: contact, contentType: "text/html" }));
      await tab.goto("https://fixture.asksite.example/contact#quote", { waitUntil: "load" });
      const got = await tab.evaluate(() => {
        const name = document.querySelector("#contact-name").getBoundingClientRect();
        const header = document.querySelector("header").getBoundingClientRect();
        const label = document.querySelector('label[for="contact-name"]').getBoundingClientRect();
        return { label: label.top, field: name.bottom, under: getComputedStyle(document.querySelector("header")).position === "sticky" ? header.bottom : 0, height: window.innerHeight };
      });
      if (got.label < got.under || got.field > got.height) found.push(`${width}x${height}: ${JSON.stringify(got)}`);
      await tab.unroute("https://fixture.asksite.example/contact");
    }
    expect(found).toEqual([]);
  }, 60_000);
});
