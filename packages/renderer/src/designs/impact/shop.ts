// STARTER (B0): the design-neutral shop blocks (shop/neutral.ts), so the shop renders before this design has its own.
// B1 (Bold) owns this file and replaces it with the design's own renderProductGrid and renderProductPage
// (the ShopDesign contract, shop/design.ts), built from shop/markup.ts and styled by styles/sheets/impact-shop.css.
export { renderProductGrid, renderProductPage } from "../../shop/neutral.ts";
