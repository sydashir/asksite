import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { apexPlaceholder, formProblems, messageTooLong, notFound, siteBusy, thankYou, tooManyRequests, unavailable, unreadableForm } from "../src/pages.ts";
import { watchCsp } from "./csp.ts";
import { E2E_FIXTURES } from "./global-setup.ts";

const ROOT = "localhost:8789";
const sites = (): Record<string, { siteId: string; url: string }> => JSON.parse(process.env["ASKSITE_E2E_SITES"] ?? "{}");

// The same gates as Plan 1's e2e: every WCAG 2.2 A/AA violation, whatever axe's impact rating (impact is
// severity, not the WCAG level: meta-viewport is AA but rated moderate; A9 item 4), plus every structure rule.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const STRUCTURE_RULES = [
  "region",
  "heading-order",
  "landmark-one-main",
  "landmark-unique",
  "landmark-no-duplicate-banner",
  "landmark-no-duplicate-contentinfo",
  "landmark-no-duplicate-main",
  "landmark-banner-is-top-level",
  "landmark-contentinfo-is-top-level",
  "landmark-main-is-top-level",
  "page-has-heading-one",
];

async function axeProblems(page: Page): Promise<string[]> {
  const wcag = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const structure = await new AxeBuilder({ page }).withRules(STRUCTURE_RULES).analyze();
  return [...wcag.violations, ...structure.violations].map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const fixture of E2E_FIXTURES) {
  test.describe(`published ${fixture}`, () => {
    test("is served by the Worker with its photos and zero CSP violations", async ({ page }) => {
      const violations = await watchCsp(page);
      const badPhotos: string[] = [];
      page.on("response", (r) => {
        if (r.url().startsWith(`https://media.${ROOT}/`) && r.status() !== 200) badPhotos.push(`${r.status()} ${r.url()}`);
      });
      page.on("requestfailed", (r) => badPhotos.push(`failed ${r.url()}`));
      const response = await page.goto(sites()[fixture]?.url ?? "");
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-security-policy"]).toContain(`img-src https://media.${ROOT};`);
      await page.waitForLoadState("load");
      // Gallery photos are lazy-loaded: scroll each into view, then wait for it to decode.
      for (const img of await page.locator("img").all()) {
        await img.scrollIntoViewIfNeeded();
        await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
      }
      expect(badPhotos).toEqual([]);
      expect(await violations()).toEqual([]);
    });
  });
}

test.describe("contact form in a real browser", () => {
  test("submits to the Worker and lands on the thank-you page", async ({ page }) => {
    const site = sites()["plumber-austin"];
    const violations = await watchCsp(page);
    await page.goto(site?.url ?? "");
    await page.getByLabel("Name").fill("Pat Browser");
    await page.getByLabel("Phone").fill("(512) 555-0123");
    await page.getByLabel("How can we help? (optional)").fill("Leaking tap");
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page).toHaveURL(`${site?.url}_f/${site?.siteId}/sent`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Thanks! Your message was sent.");
    expect(await violations()).toEqual([]);
    expect(await axeProblems(page)).toEqual([]);
  });

  test("shows plain-words problems for a bad phone number, without the typed text", async ({ page }) => {
    const site = sites()["cleaning-minimal"];
    await page.goto(site?.url ?? "");
    await page.getByLabel("Name").fill("Pat");
    await page.getByLabel("Phone").fill("call me");
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Please check your details");
    await expect(page.getByRole("listitem")).toHaveText(["Please enter a phone number we can call back, with at least 7 digits. Use only digits, spaces, dashes, dots, parentheses and a plus sign, and leave out any extension."]);
    expect(await page.content()).not.toContain("call me");
    expect(await axeProblems(page)).toEqual([]);
  });
});

test.describe("fixed pages", () => {
  // Two fixed pages hold variable text: the business phone on the site-busy page (A15), and abuse@<root>
  // on the apex page. The latter has no break opportunity (UAX #14: LB15d, LB28, LB29), so the longest
  // legal root name must reflow too.
  const LONGEST_ROOT = ["w".repeat(63), "w".repeat(63), "w".repeat(63), "w".repeat(61)].join("."); // 253 characters
  const PAGES: Array<[string, () => Response]> = [
    ["apex placeholder", () => apexPlaceholder(ROOT)],
    ["apex placeholder for the longest root domain", () => apexPlaceholder(LONGEST_ROOT)],
    ["404", () => notFound(ROOT)],
    ["503", () => unavailable(ROOT)],
    ["thank-you", () => thankYou(ROOT)],
    ["rate limited", () => tooManyRequests(ROOT)],
    ["site busy", () => siteBusy(ROOT, Date.now(), null)],
    ["site busy with the business phone", () => siteBusy(ROOT, Date.now(), { text: "(512) 555-0142", tel: "+15125550142" })],
    ["unreadable form", () => unreadableForm(ROOT)],
    ["message too long", () => messageTooLong(ROOT)],
    ["form problems", () => formProblems(ROOT, ["Please enter your name (up to 80 characters).", "Please check your email address, or leave it empty."])],
  ];

  for (const [name, build] of PAGES) {
    test(`${name} passes axe and reflows at 320 px`, async ({ page }) => {
      await page.setContent(await build().text());
      expect(await axeProblems(page)).toEqual([]);
      await page.setViewportSize({ width: 320, height: 640 });
      expect(await sidewaysScroll(page)).toBe(0);
    });
  }

  test("the live 404 and apex pages come from the Worker with noindex", async ({ page }) => {
    const missing = await page.goto(`https://${ROOT}/nope`);
    expect(missing?.status()).toBe(404);
    expect(missing?.headers()["x-robots-tag"]).toBe("noindex");
    const apex = await page.goto(`https://${ROOT}/`);
    expect(apex?.status()).toBe(200);
    expect(await axeProblems(page)).toEqual([]);
  });
});

test.describe("the gates can fail (RED proof)", () => {
  test("the CSP watcher sees a blocked image", async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto(sites()["cleaning-minimal"]?.url ?? "");
    await page.evaluate(() => {
      const img = document.createElement("img");
      img.src = "https://images.example.com/x.png";
      img.alt = "x";
      document.body.append(img);
    });
    await expect.poll(violations).toEqual(["img-src https://images.example.com/x.png"]);
  });

  test("axe sees a fixed page without its main landmark", async ({ page }) => {
    await page.setContent((await notFound(ROOT).text()).replace("<main>", "<div>").replace("</main>", "</div>"));
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toContain("region");
  });

  test("the axe gate fails on a WCAG AA violation that axe rates moderate (zoom turned off)", async ({ page }) => {
    await page.setContent((await notFound(ROOT).text()).replace("initial-scale=1", "initial-scale=1, maximum-scale=1, user-scalable=no"));
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(violations.map((v) => `${v.id} ${v.impact}`)).toEqual(["meta-viewport moderate"]);
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toEqual(["meta-viewport"]);
  });

  test("the axe gate fails on a WCAG A violation that axe rates minor (a deprecated ARIA role)", async ({ page }) => {
    await page.setContent((await notFound(ROOT).text()).replace("<main>", '<main>\n<div role="directory"><p>Old role</p></div>'));
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(violations.map((v) => `${v.id} ${v.impact}`)).toEqual(["aria-deprecated-role minor"]);
    expect((await axeProblems(page)).map((line) => line.split(":")[0])).toEqual(["aria-deprecated-role"]);
  });
});
