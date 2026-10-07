// Kept apart from the widget loader (lib/turnstile.ts) so it needs no DOM and its unit test runs in Node.

/** The widget's normal size is 300 px wide, compact 150 px (widget configurations page). */
export const NORMAL_WIDGET_WIDTH = 300;

export type WidgetSize = "normal" | "compact";

/** M4: compact when the container is narrower than the normal widget, measured at render, not by viewport. */
export function widgetSize(containerWidth: number): WidgetSize {
  return containerWidth < NORMAL_WIDGET_WIDTH ? "compact" : "normal";
}
