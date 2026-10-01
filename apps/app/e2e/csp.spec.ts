import { expect, test, type Page } from "@playwright/test";
import { APP, watchCsp } from "./support.ts";

const INLINE = /^event script-src(-elem)? inline$/;

/** Serves `body` at `path` under the app's real policy, read from GET /. */
async function serveUnderPolicy(page: Page, path: string, body: string) {
  const policy = (await page.request.get(`${APP}/`)).headers()["content-security-policy"] ?? "";
  expect(policy).toContain("script-src 'self'");
  await page.route(`${APP}${path}`, (route) => route.fulfill({ contentType: "text/html", headers: { "content-security-policy": policy }, body }));
}

// STRICT (CSP): watchCsp must catch a real violation in every engine, Firefox included, where the
// console carries no matchable text. The probe page carries the app's real policy and an inline script.
test("watchCsp reports an inline script that the app's policy blocks @firefox", async ({ page }) => {
  await serveUnderPolicy(page, "/__csp-probe", "<!doctype html><title>probe</title><script>window.ran = true</script>");
  const violations = await watchCsp(page);
  await page.goto(`${APP}/__csp-probe`);
  // The event entry itself, not just any entry: only the event collector words it this way.
  await expect.poll(violations).toContainEqual(expect.stringMatching(INLINE));
  expect(await page.evaluate(() => (window as unknown as { ran?: boolean }).ran)).toBeUndefined();
});

// STRICT (CSP): events reach Node through a binding, so they survive a navigation and come from child frames.
test("watchCsp keeps violations across navigations and from a sandboxed srcdoc frame @firefox", async ({ page }) => {
  const inlineScript = "<!doctype html><title>probe</title><script>window.ran = true</script>";
  // Sandboxed without allow-scripts, like the owner preview; its inherited policy blocks the cross-origin image.
  const frame = `<img src="https://blocked.example/x.png">`;
  await serveUnderPolicy(page, "/__csp-a", inlineScript);
  await page.route(`${APP}/__csp-b`, async (route) => {
    const policy = (await page.request.get(`${APP}/`)).headers()["content-security-policy"] ?? "";
    await route.fulfill({
      contentType: "text/html",
      headers: { "content-security-policy": policy },
      body: `<!doctype html><title>b</title><script>window.ran = true</script><iframe sandbox srcdoc='${frame}'></iframe>`,
    });
  });
  const violations = await watchCsp(page);
  await page.goto(`${APP}/__csp-a`);
  await expect.poll(violations).toContainEqual(expect.stringMatching(INLINE));
  await page.goto(`${APP}/__csp-b`);
  await expect
    .poll(async () => (await violations()).filter((entry) => INLINE.test(entry)).length)
    .toBe(2);
  // Measured (Playwright 1.63.0): Firefox runs the init script in the sandboxed frame, so the frame's violation arrives as an
  // event; Chromium and WebKit do not run it there (no allow-scripts), so the frame's violation arrives as console text,
  // which Playwright delivers from every frame. Either way it is collected.
  await expect.poll(violations).toContainEqual(expect.stringMatching(/^(event img-src https:\/\/blocked\.example\/x\.png|console [\s\S]*blocked\.example\/x\.png[\s\S]*)$/));
});

// STRICT (CSP): a SAME-ORIGIN child frame (a plain srcdoc, not sandboxed) with a blocked image. Firefox words its console
// line "Content-Security-Policy" (hyphens), so the console channel must match that spelling too, not only the event channel.
test("watchCsp reads Firefox's hyphenated console line from a same-origin srcdoc frame @firefox", async ({ page }) => {
  const policy = (await page.request.get(`${APP}/`)).headers()["content-security-policy"] ?? "";
  await page.route(`${APP}/__csp-same`, (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "content-security-policy": policy },
      body: `<!doctype html><title>same</title><iframe srcdoc='<img src="https://blocked.example/same.png">'></iframe>`,
    }),
  );
  const violations = await watchCsp(page);
  await page.goto(`${APP}/__csp-same`);
  await expect.poll(violations).toContainEqual(expect.stringMatching(/^console [\s\S]*blocked\.example\/same\.png/));
});
