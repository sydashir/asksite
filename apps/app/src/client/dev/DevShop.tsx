import { useState, type MouseEvent } from "react";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { combinations, type ProductDraft, type ProductSummary } from "../shop/catalog.ts";
import { OrderDetail } from "../shop/OrderDetail.tsx";
import { OrderList } from "../shop/OrderList.tsx";
import { productErrors } from "../shop/product-errors.ts";
import { ProductForm } from "../shop/ProductForm.tsx";
import { ProductList } from "../shop/ProductList.tsx";
import { ShopSettings, type ShopSettingsDraft } from "../shop/ShopSettings.tsx";
import type { OrderFilter, OrderStatus, OrderSummary, OrderView } from "../shop/orders.ts";

// Development only: the shop screens with made-up data, one state per address (/dev/shop?view=…), so they can be looked at,
// screenshotted and checked before lane A wires them to the API. Nothing here is saved.

const VIEWS = [
  ["products", "Products"],
  ["products-empty", "Products: none yet"],
  ["products-loading", "Products: loading"],
  ["products-error", "Products: could not load"],
  ["product", "A product with sizes and colours"],
  ["product-new", "A new product, with every check showing"],
  ["settings", "Shop settings"],
  ["orders", "Orders"],
  ["orders-empty", "Orders: none yet"],
  ["order", "One order"],
] as const;
type View = (typeof VIEWS)[number][0];

const photo = (name: string) => `${location.origin}/landing/${name}`;
const T = Date.parse("2026-10-15T14:14:00");

const PRODUCTS: ProductSummary[] = [
  { id: "p1", name: "Mom Flipflop", photoUrl: photo("modern-desktop.webp"), prices: [990, 990, 1190], choicesText: "Sizes 6–11 · Black, Coral", soldOut: false, soldOutChoices: ["Size 8, Colour Coral"] },
  { id: "p2", name: "Hip Hop Flip Flopp 🩴 extra soft summer edition with a long name that wraps onto a second line", photoUrl: null, prices: [750], choicesText: null, soldOut: false, soldOutChoices: [] },
  { id: "p3", name: "Beach Tote", photoUrl: photo("classic-desktop.webp"), prices: [2400], choicesText: null, soldOut: true, soldOutChoices: [] },
];

const OPTIONS = [
  { name: "Size", values: ["6", "7", "8", "9", "10", "11"] },
  { name: "Colour", values: ["Black", "Coral"] },
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

const ORDERS: OrderSummary[] = [
  { id: "o1", number: 1042, createdAt: T, buyerName: "Maria Lopez", status: "new", totalCents: 2730, lines: [{ name: "Mom Flipflop", choice: "Size 8, Black", quantity: 2, unitCents: 990, lineCents: 1980 }, { name: "Kid Flipflop", choice: "Size 6", quantity: 1, unitCents: 750, lineCents: 750 }] },
  { id: "o2", number: 1041, createdAt: T - 86_400_000, buyerName: "Sam Reed", status: "open", totalCents: 2400, lines: [{ name: "Beach Tote", choice: null, quantity: 1, unitCents: 2400, lineCents: 2400 }] },
  { id: "o3", number: 1040, createdAt: T - 3 * 86_400_000, buyerName: "Christopher Montgomery-Washington the Third", status: "done", totalCents: 129_950, lines: [{ name: "Hip Hop Flip Flopp 🩴 extra soft summer edition", choice: "Size 11", quantity: 99, unitCents: 1190, lineCents: 117_810 }, { name: "Beach Tote", choice: null, quantity: 1, unitCents: 12_140, lineCents: 12_140 }] },
];
const ORDER: OrderView = {
  ...ORDERS[0]!,
  payment: "not-online",
  buyer: { name: "Maria Lopez", email: "maria@example.com", phone: "(512) 555-0142", address: "1200 Barton Springs Rd\nApt 4\nAustin, TX 78704" },
  note: "Can you deliver Saturday morning?\nThanks!",
};

const stay = (event: MouseEvent<HTMLAnchorElement>) => event.preventDefault();

export function DevShop() {
  const heading = usePageHeading<HTMLHeadingElement>("Shop screens");
  const view = (new URLSearchParams(location.search).get("view") ?? "") as View | "";
  const [products, setProducts] = useState(PRODUCTS);
  const [product, setProduct] = useState(view === "product-new" ? NEW_PRODUCT : FULL_PRODUCT);
  const [settings, setSettings] = useState(SETTINGS);
  const [filter, setFilter] = useState<OrderFilter>("all");
  const [status, setStatus] = useState<OrderStatus>(ORDER.status);
  const [message, setMessage] = useState("");
  const [photoStatus, setPhotoStatus] = useState("");

  const move = (id: string, direction: "up" | "down") => {
    const i = products.findIndex((p) => p.id === id);
    const j = direction === "up" ? i - 1 : i + 1;
    const next = [...products];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setProducts(next);
  };
  const listState = view === "products-loading" ? "loading" : view === "products-error" ? "error" : "ready";
  const shownOrders = view === "orders-empty" ? [] : ORDERS.filter((o) => filter === "all" || o.status === filter);

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
            <ShopSettings settings={settings} onChange={setSettings} errors={(path) => (path[0] === "fulfilment" && settings.fulfilment.length === 0 ? ["Tick at least one way buyers get their orders."] : [])} />
          </div>
        ) : null}
        {view === "orders" || view === "orders-empty" ? (
          <OrderList
            orders={shownOrders}
            filter={filter}
            counts={view === "orders-empty" ? {} : { new: 1, open: 1, done: 1, all: 3 }}
            onFilter={setFilter}
            hrefFor={(id) => `/dev/shop?view=order&id=${id}`}
            onOpen={() => undefined}
            businessName="Hip Hop Flip Flopp"
            state="ready"
            onRetry={() => undefined}
          />
        ) : null}
        {view === "order" ? (
          <OrderDetail
            order={{ ...ORDER, status }}
            businessName="Hip Hop Flip Flopp"
            backHref="/dev/shop?view=orders"
            onBack={stay}
            busy={false}
            message={message}
            onSetStatus={(next) => {
              setStatus(next);
              setMessage(next === "done" ? "Marked as done." : "Marked as new.");
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
