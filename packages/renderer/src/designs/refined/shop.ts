// STARTER (B0): the design-neutral shop blocks (shop/neutral.ts), so the shop renders before this design has its own.
// B2 (Classic) owns this file and replaces it with the design's own renderProductGrid and renderProductPage
// (the ShopDesign contract, shop/design.ts), built from shop/markup.ts and styled by styles/sheets/refined-shop.css.
export { renderProductGrid, renderProductPage } from "../../shop/neutral.ts";
