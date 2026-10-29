// The document behind Bold's about--solo layout (an About with no photo, no founding year and no credentials), shared
// by about-solo.test.ts and about-solo.browser.test.ts.
import { MINIMAL } from "../../support/doc.ts";

export const SOLO_DOC = { ...MINIMAL, copy: { ...MINIMAL.copy, about: "We clean homes across Austin, one room at a time." }, theme: { ...MINIMAL.theme, design: "impact" as const } };
