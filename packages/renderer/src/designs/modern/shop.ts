// STARTER (B0): the design-neutral shop blocks (shop/neutral.ts), so the shop renders before this design has its own.
// B3 (Modern) owns this file and replaces it with the design's own renderProductGrid and renderProductPage
// (the ShopDesign contract, shop/design.ts), built from shop/markup.ts and styled by styles/sheets/modern-shop.css.
export { renderProductGrid, renderProductPage } from "../../shop/neutral.ts";
