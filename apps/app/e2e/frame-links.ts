import { expect, type FrameLocator, type Page } from "@playwright/test";

/** What the status line says when a link in the preview frame tried to leave the shown page (components/page-preview.tsx). */
export const LINKS_OFF = "Links are turned off in the preview.";

/** The title the renderer gives each page of Joe's Plumbing (renderer pageTitle): proves WHICH page the frame shows. */
export const JOES_TITLE = { home: /^Joe's Plumbing \| Plumbing in Austin, TX$/, services: /^Services \| Joe's Plumbing$/ } as const;

/** Waits until the frame's page has this title (read from the element: a head element has no visible text for toHaveText). */
export async function expectFrameTitle(frame: FrameLocator, title: RegExp, message?: string): Promise<void> {
  await expect.poll(() => frame.locator("head > title").evaluate((el) => el.textContent ?? "").catch(() => ""), { message: message ?? "the frame shows this page" }).toMatch(title);
}

/**
 * Brings the preview frame's bottom onto the PAGE. Bold's call bar ("Get a quote") sits at the bottom of the frame, and Bold's
 * `scroll-padding-bottom` makes Playwright's scroll-into-view scroll only the frame, not the page, so the link can stay below the
 * fold and the click fails as "outside of the viewport". A no-op when the bottom is already on screen.
 */
export async function scrollFrameBottomIntoView(page: Page, frameSelector: string): Promise<void> {
  await page.locator(frameSelector).evaluate((el) => el.scrollIntoView({ block: "end" }));
}

/**
 * The proof that links in the preview frame go nowhere (hand-off item 3). For each of a navigation link ("Services") and
 * the call to action (`ctaName`, "Get a quote" unless the site has its own wording), pressed by a mouse click and by Enter on the focused link: the frame stays on the shown page (its title
 * is that page's, and it is still an about:srcdoc frame, never another address), the page itself never navigates, and the
 * parent announces the status line. `open` loads the screen afresh with the frame showing Home; `frame` is the iframe's
 * selector. A last round does it again on the Services page, so a page other than Home is covered too.
 */
export async function expectLinksStayInFrame(page: Page, frameSelector: string, open: () => Promise<void>, ctaName = "Get a quote"): Promise<void> {
  const frame = page.frameLocator(frameSelector);
  const status = page.getByText(LINKS_OFF);
  const pageUrl = () => page.url();

  async function attempt(link: string, how: "click" | "enter", shown: "home" | "services") {
    await open();
    if (shown === "services") await page.getByRole("group", { name: "Page", exact: true }).getByRole("button", { name: "Services" }).click();
    await expectFrameTitle(frame, JOES_TITLE[shown]);
    await expect(status).toHaveCount(0);
    const before = pageUrl();
    const target = frame.getByRole("link", { name: link, exact: true }).first();
    // Below 1024 px the renderer's menu is a <details>: its links are hidden until the menu is opened (a click on the frame's own summary).
    if ((await target.count()) === 0) await frame.locator("details > summary").click();
    await scrollFrameBottomIntoView(page, frameSelector);
    if (how === "click") await target.click();
    else {
      await target.focus();
      await page.keyboard.press("Enter");
    }
    await expect(status, `${how} on "${link}" (${shown})`).toBeVisible();
    await expectFrameTitle(frame, JOES_TITLE[shown], `${how} on "${link}" (${shown})`);
    expect(pageUrl()).toBe(before);
    expect(page.frames().filter((f) => f.parentFrame() !== null).map((f) => f.url())).toEqual(["about:srcdoc"]);
    await expect(page.getByRole("group", { name: "Page", exact: true }).getByRole("button", { name: shown === "home" ? "Home" : "Services" })).toHaveAttribute("aria-pressed", "true");
  }

  for (const how of ["click", "enter"] as const) {
    for (const link of ["Services", ctaName] as const) await attempt(link, how, "home");
    await attempt(ctaName, how, "services");
  }
}
