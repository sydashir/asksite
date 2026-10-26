import { useState } from "react";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { combinations, type ProductDraft, type ProductSummary } from "../shop/catalog.ts";
import { productErrors } from "../shop/product-errors.ts";
import { ProductForm } from "../shop/ProductForm.tsx";
import { ProductList } from "../shop/ProductList.tsx";
import { ShopSettings, type ShopSettingsDraft } from "../shop/ShopSettings.tsx";

// Development only: the product screens with made-up data, one state per address (/dev/shop?view=…), so they can be looked at,
// screenshotted and checked before lane A wires them to the API. Nothing here is saved.

const VIEWS = [
  ["products", "Products"],
  ["products-empty", "Products: none yet"],
  ["products-loading", "Products: loading"],
  ["products-error", "Products: could not load"],
  ["product", "A product with sizes and colors"],
  ["product-new", "A new product, with every check showing"],
  ["settings", "Shop settings"],
] as const;
type View = (typeof VIEWS)[number][0];

const photo = (name: string) => `${location.origin}/landing/${name}`;

const PRODUCTS: ProductSummary[] = [
  { id: "p1", name: "Mom Flipflop", photoUrl: photo("modern-desktop.webp"), prices: [990, 990, 1190], choicesText: "Sizes 6–11 · Black, Coral", soldOut: false, soldOutChoices: ["Size 8, Color Coral"] },
  { id: "p2", name: "Hip Hop Flip Flopp 🩴 extra soft summer edition with a long name that wraps onto a second line", photoUrl: null, prices: [750], choicesText: null, soldOut: false, soldOutChoices: [] },
  { id: "p3", name: "Beach Tote", photoUrl: photo("classic-desktop.webp"), prices: [2400], choicesText: null, soldOut: true, soldOutChoices: [] },
];

const OPTIONS = [
  { name: "Size", values: ["6", "7", "8", "9", "10", "11"] },
  { name: "Color", values: ["Black", "Coral"] },
];
const FULL_PRODUCT: ProductDraft = {
  name: "Mom Flipflop",
  slug: "mom-flipflop",
  priceText: "9.90",
  compareAtText: "14",
  description: "Soft foam footbed and a wide strap. Made for long summer days.",
  soldOut: false,
  maxQtyText: "",
  photos: [
    { upload: "u1", url: photo("modern-desktop.webp"), alt: "" },
    { upload: "u2", url: photo("bold-desktop.webp"), alt: "The coral pair on sand" },
  ],
  options: OPTIONS,
  variants: combinations(OPTIONS).map((values, i) => ({ id: `v${i}`, values, offered: !(values[0] === "11" && values[1] === "Coral"), priceText: values[0] === "11" ? "11.90" : "", compareAtText: "", soldOut: values[0] === "8" && values[1] === "Coral" })),
};
const NEW_PRODUCT: ProductDraft = { name: "", slug: "Mom Flipflop", priceText: "9,90", compareAtText: "", description: "", soldOut: false, maxQtyText: "100", photos: [], options: [], variants: [] };

const SETTINGS: ShopSettingsDraft = { fulfilment: ["pickup", "shipping"], orderNote: "Pickup Tuesday to Saturday at our Austin store.", returns: "", sizing: "Runs true to size. Between sizes? Take the bigger one.", formerPricesConfirmed: true };


export function DevShop() {
  const heading = usePageHeading<HTMLHeadingElement>("Shop screens");
  const view = (new URLSearchParams(location.search).get("view") ?? "") as View | "";
  const [products, setProducts] = useState(PRODUCTS);
  const [product, setProduct] = useState(view === "product-new" ? NEW_PRODUCT : FULL_PRODUCT);
  const [settings, setSettings] = useState(SETTINGS);
  const [photoStatus, setPhotoStatus] = useState("");

  const move = (id: string, direction: "up" | "down") => {
    const i = products.findIndex((p) => p.id === id);
    const j = direction === "up" ? i - 1 : i + 1;
    const next = [...products];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setProducts(next);
  };
  const listState = view === "products-loading" ? "loading" : view === "products-error" ? "error" : "ready";

  return (
    <section className="mx-auto max-w-3xl">
      <h1 ref={heading} tabIndex={-1} className="page-title">
        Shop screens
      </h1>
      <p className="dev-box mt-3">Development only. The shop screens with made-up data, before they are wired to the website. Nothing here is saved.</p>
      <nav aria-label="Screens" className="mt-4">
        <ul className="flex flex-wrap gap-2">
          {VIEWS.map(([id, label]) => (
            <li key={id}>
              <a href={`/dev/shop?view=${id}`} className="btn-small" aria-current={view === id ? "page" : undefined}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-8">
        {view.startsWith("products") ? (
          <ProductList
            products={view === "products-empty" ? [] : products}
            state={listState}
            onRetry={() => undefined}
            onAdd={() => undefined}
            onEdit={() => undefined}
            onMove={move}
          />
        ) : null}
        {view === "product" || view === "product-new" ? (
          <div className="card">
            <ProductForm
              product={product}
              onChange={setProduct}
              errors={(path) => (view === "product-new" ? productErrors(product, path) : [])}
              formerPricesConfirmed={view === "product"}
              published={view === "product"}
              defaultMaxQty={10}
              onAddPhotos={(files) => setPhotoStatus(`${files.length} ${files.length === 1 ? "photo" : "photos"} would be uploaded here.`)}
              photoStatus={photoStatus}
              onBack={() => undefined}
              onDelete={() => undefined}
            />
          </div>
        ) : null}
        {view === "settings" ? (
          <div className="card">
            <ShopSettings settings={settings} onChange={setSettings} errors={(path) => (path[0] === "fulfilment" && settings.fulfilment.length === 0 ? ["Check at least one way buyers get their orders."] : [])} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
