import { expect, test } from "@playwright/test";
import { watchCsp } from "./csp.ts";

// The deployed smoke-test page (Task 19 Step 11) in a real browser: every photo loads from the real
// media host under the real CSP, the page reports zero CSP violations, and nothing is fetched from
// /cdn-cgi/ (no Cloudflare feature may inject scripts into approved pages; Task 19 Step 6).
const URL_UNDER_TEST = process.env["ASKSITE_SMOKE_URL"] ?? "";

test("the deployed page loads its photos, reports zero CSP violations and loads nothing injected", async ({ page }) => {
  expect(URL_UNDER_TEST, "set ASKSITE_SMOKE_URL to the page's https address").toMatch(/^https:\/\//);
  const violations = await watchCsp(page);
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  const response = await page.goto(URL_UNDER_TEST);
  expect(response?.status()).toBe(200);
  const images = await page.locator("img").all();
  expect(images.length).toBeGreaterThan(0);
  for (const img of images) {
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
  }
  expect(requested.filter((url) => url.includes("/cdn-cgi/"))).toEqual([]);
  expect(await violations()).toEqual([]);
});
