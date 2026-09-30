import type { Palette } from "../../src/theme.ts";

export type Pair = [label: string, fg: string, bg: string];

const WHITE = "#FFFFFF";

// Every text-on-background pair today's section templates use. Adding a new pairing to a
// template means adding it here first. A design with its own templates lists its own pairs in
// test/designs/<id>/pairs.ts (A12).
export function pairs(p: Palette): Pair[] {
  const onSurfaces = (["textHeading", "textDefault", "textMuted", "primary", "secondary", "link"] as const).flatMap(
    (key): Pair[] => [
      [`${key} on page`, p[key], p.bgPage],
      [`${key} on white card`, p[key], WHITE],
    ],
  );
  return [
    ...onSurfaces,
    ["white on primary button", WHITE, p.primary],
    ["white on secondary (button hover)", WHITE, p.secondary],
    ["white on dark band", WHITE, p.bgPageDark],
    ["heading text on accent badge", p.textHeading, p.accent],
  ];
}
