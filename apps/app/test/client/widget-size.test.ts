import { describe, expect, it } from "vitest";
import { NORMAL_WIDGET_WIDTH, widgetSize } from "../../src/client/lib/widget-size.ts";

// Cloudflare's widget sizes (developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/):
// normal is 300 px wide, compact 150 px. M4: compact when the widget's container is narrower than 300 px.
describe("widgetSize", () => {
  it("is normal at 300 px and wider, compact below", () => {
    expect(NORMAL_WIDGET_WIDTH).toBe(300);
    expect(widgetSize(300)).toBe("normal");
    expect(widgetSize(324)).toBe("normal");
    expect(widgetSize(299.5)).toBe("compact");
    expect(widgetSize(254)).toBe("compact");
    expect(widgetSize(0)).toBe("compact");
  });
});
