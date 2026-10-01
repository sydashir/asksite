import { expect, test } from "@playwright/test";
import { APP, watchCsp } from "./support.ts";

// STRICT (CSP): watchCsp must catch a real violation in every engine, Firefox included, where the
// console carries no matchable text. The probe page carries the app's real policy and an inline script.
test("watchCsp reports an inline script that the app's policy blocks @firefox", async ({ page }) => {
  const policy = (await page.request.get(`${APP}/`)).headers()["content-security-policy"] ?? "";
  expect(policy).toContain("script-src 'self'");
  await page.route(`${APP}/__csp-probe`, (route) =>
    route.fulfill({ contentType: "text/html", headers: { "content-security-policy": policy }, body: "<!doctype html><title>probe</title><script>window.ran = true</script>" }),
  );
  const violations = watchCsp(page);
  await page.goto(`${APP}/__csp-probe`);
  await expect.poll(async () => (await violations()).length).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { ran?: boolean }).ran)).toBeUndefined();
});
