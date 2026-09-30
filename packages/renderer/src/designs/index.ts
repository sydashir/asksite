import type { DesignId } from "@asksite/site-schema";
import type { Design } from "../design.ts";
import { design as impact } from "./impact/index.ts";
import { design as modern } from "./modern/index.ts";
import { design as refined } from "./refined/index.ts";

/**
 * Every page design, by id (A12). A design build changes only its own folder (its index.ts keeps
 * exporting `design`), never this file; a new id is added here once, like the id itself.
 */
export const DESIGNS: Readonly<Record<DesignId, Design>> = Object.freeze({ impact, refined, modern } satisfies Record<DesignId, Design>);
