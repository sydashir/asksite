import type { DesignId } from "@asksite/site-schema";
import * as impact from "../designs/impact/shop.ts";
import * as modern from "../designs/modern/shop.ts";
import * as refined from "../designs/refined/shop.ts";
import type { ShopDesign } from "./design.ts";

/** Every design's shop blocks, by id: each design's shop.ts (B1-B3 own them). A new design id is added here once. */
export const SHOP_DESIGNS: Readonly<Record<DesignId, ShopDesign>> = Object.freeze({ impact, refined, modern } satisfies Record<DesignId, ShopDesign>);
