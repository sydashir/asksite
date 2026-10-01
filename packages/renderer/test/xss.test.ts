import { DESIGN_IDS, PAGE_IDS, SiteDocument, type PageId } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_SITE_URL, FIXTURES, loadFixture, renderFixture, renderFixturePage, stubStylesheets } from "../../../fixtures/index.ts";
import { escapeAttr, escapeText } from "../src/escape.ts";
import { render } from "../src/index.ts";
import { pageDescription, pageTitle } from "../src/render.ts";
import { FULL } from "./support/doc.ts";
import { pageSafetyProblems, startTags } from "./support/page-safety.ts";
import { squash, squashedText } from "./support/page-text.ts";

const STUB = stubStylesheets();
const canonical = (page: { path: string }) => `${FIXTURE_SITE_URL}${page.path.slice(1)}`;
const attributesOf = (page: string) => startTags(page).flatMap((t) => t.attributes);

// Every page of every fixture in every design (A12, A16).
describe.each(DESIGN_IDS)("the %s design", (design) => {
  it.each(FIXTURES)("renders every page of %s with nothing that runs script or loads what it should not", (name) => {
    const pages = renderFixture(name, STUB, design);
    expect(pages.flatMap((p) => pageSafetyProblems(p.html, canonical(p)).map((problem) => `${p.path}: ${problem}`))).toEqual([]);
  });

  // Every free-text field of this fixture holds an XSS payload (script tags, event handlers,
  // attribute breakouts, javascript: URLs, </script> and </style> breakouts), in all nine sections.
  describe("with the electrical-xss payloads", () => {
    const pages = renderFixture("electrical-xss", STUB, design);
    const doc = SiteDocument.parse(loadFixture("electrical-xss"));
    const page = (id: PageId) => pages.find((p) => p.page === id)!.html;

    it("is a site worth checking: five pages, many attributes and links", () => {
      expect(pages.map((p) => p.page)).toEqual(PAGE_IDS);
      const attributes = pages.flatMap((p) => attributesOf(p.html));
      expect(attributes.length).toBeGreaterThan(100);
      expect(attributes.filter((a) => ["href", "src", "action"].includes(a.name)).length).toBeGreaterThan(10);
      expect(pages.map((p) => startTags(p.html).filter((t) => t.name === "script").length)).toEqual([1, 1, 0, 0, 0]);
    });

    it("shows payloads as text", () => {
      expect(page("home")).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(page("home")).toContain('alt="&quot; onerror=&quot;alert(1)"');
      expect(page("gallery")).toContain('alt="&lt;script&gt;alert(1)&lt;/script&gt;"');
      // The headline is the payload: the h1's text is exactly its escaped form, however a design wraps it.
      const home = page("home");
      const h1 = home.slice(home.indexOf("<h1"), home.indexOf("</h1>"));
      expect(squashedText(h1)).toBe(squash(escapeText(loadFixture("electrical-xss").copy.heroHeadline)));
      expect(squashedText(h1)).toBe(squash("&lt;script&gt;alert(document.domain)&lt;/script&gt;"));
    });

    // The head is written by render.ts for every design: the payloads are escaped in each title, description and canonical.
    it("escapes the payloads in every page's title, description and canonical", () => {
      for (const p of pages) {
        expect(p.html).toContain(`<title>${escapeText(pageTitle(doc, p.page))}</title>`);
        expect(p.html).toContain(`<meta name="description" content="${escapeAttr(pageDescription(doc, p.page))}">\n<link rel="canonical" href="${canonical(p)}">`);
        const head = p.html.slice(0, p.html.indexOf("</head>"));
        expect(head.match(/<title>[^<]*<\/title>/g)).toHaveLength(1);
        expect(startTags(head).filter((t) => t.name === "meta" && t.attributes.some((a) => a.name === "name" && a.value === "description"))).toHaveLength(1);
        if (p.page !== "home") expect(`${p.html.match(/<title>([^<]*)<\/title>/)?.[1]}`).toContain("&lt;img src=x onerror=alert(1)&gt;");
      }
      expect(pageTitle(doc, "services")).toBe(`Services | ${doc.facts.businessName}`);
    });

    it("keeps JSON-LD intact: payloads round-trip without breaking out", () => {
      const blocks = (id: PageId) => [...page(id).matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1] ?? "null"));
      expect(blocks("home")[0].name).toBe(doc.facts.businessName);
      expect(blocks("home")[0].url).toBe(FIXTURE_SITE_URL);
      expect(blocks("services")[0].mainEntity[0].acceptedAnswer.text).toBe(doc.copy.faq[0]?.answer);
    });
  });
});

describe("the page checks can fail (RED proof)", () => {
  const page = renderFixturePage("plumber-austin", "home", STUB);
  const inject = (markup: string) => page.replace('<main id="main">', `<main id="main">${markup}`);
  const CANONICAL = `<link rel="canonical" href="${FIXTURE_SITE_URL}">`;
  const inHead = (markup: string) => page.replace(CANONICAL, markup);

  it("pass the real page", () => {
    expect(pageSafetyProblems(page)).toEqual([]);
    expect(pageSafetyProblems(page, FIXTURE_SITE_URL)).toEqual([]);
    expect(page).toContain(CANONICAL);
  });

  it.each([
    ["<img src=x onerror=alert(1)>", ["unquoted src", "url src=x", "handler onerror", "unquoted onerror"]],
    ['<a href="javascript:alert(1)">x</a>', ["url href=javascript:alert(1)", "scheme href=javascript:alert(1)"]],
    ['<iframe src="https://evil.example/"></iframe>', ["element iframe"]],
    ["<script>alert(1)</script>", ["script <script>"]],
    ["<script>alert(1)</script><script>alert(2)</script>", ["script <script>", "script <script>", "3 scripts"]],
    ['<div style="background:url(https://evil.example/)">x</div>', ["attribute style"]],
    ["<style>p{}</style>", ["3 style blocks"]],
    ["<!-- x -->", ["2 comments"]],
    ["1 < 2", ['a raw "<" that starts none of our tags']],
    ['<small onclick="alert(1)">x</small>', ["handler onclick"]],
    ['<svg aria-hidden="true"><rect width="8" height="8" xlink:href="javascript:alert(1)"/></svg>', ["url xlink:href=javascript:alert(1)", "scheme xlink:href=javascript:alert(1)"]],
  ])("catch %s", (markup, problems) => {
    expect(pageSafetyProblems(inject(markup))).toEqual(problems);
  });

  // Strict (A16): a link is the site's own page path or an absolute https:, tel: or mailto: URL, and nothing else.
  it.each(["/", "/services", "/about", "/gallery", "/contact", "/contact#quote", "/services#faq", "/#top", "#", "#faq", "tel:+15125550142", "mailto:a@example.com", "https://example.com/x"])(
    "allow the link %s",
    (href) => {
      expect(pageSafetyProblems(inject(`<a href="${href}">x</a>`))).toEqual([]);
    },
  );

  it.each([
    "//evil.example",
    "//evil.example/services",
    "/services/../x",
    "/x",
    "/services?x",
    "/services?x=1#faq",
    "/Services",
    "/services/",
    "/contact#Quote",
    "/contact#",
    "/contact#a b",
    "/contact#quote#x",
    "/services\\evil",
    "/contact\n",
    "services",
    "./services",
    "http://example.com/",
    "ftp://example.com/",
    "",
  ])("catch the link %j", (href) => {
    expect(pageSafetyProblems(inject(`<a href="${href}">x</a>`))).toEqual([`url href=${href}`]);
  });

  it.each([
    ["a stylesheet instead", '<link rel="stylesheet" href="https://evil.example/x.css">', ['link <link rel="stylesheet" href="https://evil.example/x.css">']],
    ["a stylesheet beside it", `${CANONICAL}\n<link rel="stylesheet" href="https://evil.example/x.css">`, ["2 <link> elements", 'link <link rel="stylesheet" href="https://evil.example/x.css">']],
    ["a preload instead", '<link rel="preload" href="https://evil.example/x.js">', ['link <link rel="preload" href="https://evil.example/x.js">']],
    ["a preload beside it", `${CANONICAL}\n<link rel="preload" href="https://evil.example/x.js">`, ["2 <link> elements", 'link <link rel="preload" href="https://evil.example/x.js">']],
    ["a second canonical", `${CANONICAL}\n${CANONICAL}`, ["2 <link> elements"]],
    ["an http: canonical", '<link rel="canonical" href="http://fixture.asksite.example/">', ["url href=http://fixture.asksite.example/", 'link <link rel="canonical" href="http://fixture.asksite.example/">']],
    ["a canonical with another attribute", '<link rel="canonical" href="https://fixture.asksite.example/" hreflang="en">', ['link <link rel="canonical" href="https://fixture.asksite.example/" hreflang="en">']],
    ["a canonical to a path", '<link rel="canonical" href="/services">', ['link <link rel="canonical" href="/services">']],
    ["no canonical at all", "", ["0 <link> elements"]],
  ])("catch %s in the head", (_, markup, problems) => {
    expect(pageSafetyProblems(inHead(markup))).toEqual(problems);
  });

  it("catch a canonical that is not the page's own address", () => {
    expect(pageSafetyProblems(inHead('<link rel="canonical" href="https://evil.example/">'), FIXTURE_SITE_URL)).toEqual([`canonical https://evil.example/, expected ${FIXTURE_SITE_URL}`]);
  });

  // The page designs' mockups use these (A12-0 round-2 rulings); every attribute check still applies to them.
  it("pass the harmless elements designs use: dl, dt, dd, strong, small, wbr and the svg shapes", () => {
    const markup =
      '<dl><dt>Mon</dt><dd>7 AM</dd></dl><p><strong>A</strong> <small>b</small> c<wbr>d</p>' +
      '<svg aria-hidden="true" viewBox="0 0 8 8"><g><rect width="8" height="8"/><circle r="1"/><line x2="1"/><polyline points="0 0 1 1"/><polygon points="0 0 1 1"/></g></svg>';
    expect(pageSafetyProblems(inject(markup))).toEqual([]);
  });
});

describe("the render boundary", () => {
  it("refuses a theme payload", () => {
    const options = { stylesheets: stubStylesheets(""), formAction: "https://forms.example.com/submit", siteUrl: FIXTURE_SITE_URL };
    const payload = "red;}</style><script>alert(1)</script>";
    expect(() => render({ ...FULL, theme: { palette: payload, font: "clean" } } as never, options)).toThrow('"palette"');
    expect(() => render({ ...FULL, theme: { palette: "navy-orange", font: payload } } as never, options)).toThrow('"font"');
    expect(() => render({ ...FULL, theme: { palette: "navy-orange", font: "clean", design: payload } } as never, options)).toThrow('"design"');
  });
});
