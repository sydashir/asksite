import { describe, expect, it } from "vitest";
import { PREVIEW_ONLY_STYLE, withLinksOff } from "../../src/client/lib/preview.ts";

// The review preview turns in-page links off (they would navigate the srcdoc frame to the admin's own URL). The style
// goes only into the copy shown in the frame, never into the stored page.
describe("withLinksOff", () => {
  it("adds the preview-only style at the end of the head, and leaves the rest of the page as it was", () => {
    const stored = "<!doctype html><html><head><title>x</title></head><body><a href=\"#contact\">Call</a></body></html>";
    const shown = withLinksOff(stored);
    expect(shown).toBe(`<!doctype html><html><head><title>x</title>${PREVIEW_ONLY_STYLE}</head><body><a href="#contact">Call</a></body></html>`);
    expect(PREVIEW_ONLY_STYLE).toBe("<style>a[href]{pointer-events:none;cursor:default}</style>");
    expect(stored).not.toContain("pointer-events");
  });

  it("still adds the style to a page with no head", () => {
    expect(withLinksOff("<p>hi</p>")).toBe(`${PREVIEW_ONLY_STYLE}<p>hi</p>`);
  });
});
