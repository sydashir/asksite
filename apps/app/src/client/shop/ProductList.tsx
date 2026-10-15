import { isSafeUrl } from "@asksite/site-schema";
import { Notice } from "../components/feedback.tsx";
import { priceRangeText } from "../lib/money.ts";
import { PRODUCT_LIMITS, productStatus, type ProductSummary } from "./catalog.ts";

interface Props {
  products: readonly ProductSummary[];
  state: "loading" | "error" | "ready";
  errorMessage?: string;
  onRetry: () => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  /** Display order is list order: the shop shows them in this order. */
  onMove: (id: string, direction: "up" | "down") => void;
  readOnly?: boolean;
}

function Arrow({ up }: { up: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
    </svg>
  );
}

/**
 * The shop's products in the order the website shows them: a photo, the name (which opens the product), the price (or "From"
 * the lowest), the choices, and the state in words. Up and Down change the order. Up to 24 products (the contract's cap).
 */
export function ProductList(props: Props) {
  const readOnly = props.readOnly === true;
  const full = props.products.length >= PRODUCT_LIMITS.products;
  const add = (
    <button type="button" className="btn-primary" aria-disabled={readOnly || full} onClick={() => (readOnly || full ? undefined : props.onAdd())}>
      Add a product
    </button>
  );
  return (
    <section aria-labelledby="products-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="products-title" className="section-title">
            Products
          </h2>
          {props.state === "ready" && props.products.length > 0 ? (
            <p className="meta text-sm">
              {props.products.length} of {PRODUCT_LIMITS.products}
              {full ? ". The shop is full: remove a product to add another." : ""}
            </p>
          ) : null}
        </div>
        {props.state === "ready" && props.products.length > 0 ? add : null}
      </div>

      {props.state === "loading" ? (
        <p role="status" className="loading mt-4">
          <span className="spinner" aria-hidden="true" />
          Loading the products…
        </p>
      ) : null}
      {props.state === "error" ? (
        <div role="alert">
          <Notice tone="error">
            {props.errorMessage ?? "We couldn't load the products."}
            <button type="button" className="btn-secondary mt-3 flex" onClick={props.onRetry}>
              Try again
            </button>
          </Notice>
        </div>
      ) : null}
      {props.state === "ready" && props.products.length === 0 ? (
        <div className="empty-state mt-4">
          <p className="font-semibold text-ink">No products yet</p>
          <p className="mt-1 text-slate-700">A name and a price are enough to start. Photos, sizes and colours can come later.</p>
          <div className="mt-5">{add}</div>
        </div>
      ) : null}

      {props.state === "ready" && props.products.length > 0 ? (
        <ol className="mt-4 divide-y divide-slate-100 rounded-card border border-slate-200 bg-white">
          {props.products.map((product, i) => (
            <li key={product.id} className="product-row">
              {product.photoUrl !== null && isSafeUrl(product.photoUrl, ["https:"]) ? <img src={product.photoUrl} alt="" className="thumb" /> : <span aria-hidden="true" className="thumb" />}
              <div className="min-w-0 flex-1">
                <button type="button" className="product-name" onClick={() => props.onEdit(product.id)}>
                  <span className="sr-only">Edit </span>
                  {product.name}
                </button>
                <p className="mt-0.5 text-sm text-slate-700">
                  <span className="font-semibold tabular-nums text-ink">{product.prices.length > 0 ? priceRangeText(product.prices) : "No price"}</span>
                  {product.choicesText !== null ? <span> · {product.choicesText}</span> : null}
                </p>
                <p className="mt-1.5 flex flex-wrap gap-1.5">
                  {productStatus(product).map((word) => (
                    <span key={word.text} className={word.tone === "brand" ? "pill-brand" : "pill"}>
                      {word.text}
                    </span>
                  ))}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" className="btn-small gap-1" aria-label={`Move ${product.name} up`} aria-disabled={readOnly || i === 0} onClick={() => (readOnly || i === 0 ? undefined : props.onMove(product.id, "up"))}>
                  <Arrow up />
                  <span aria-hidden="true" className="hidden sm:inline">
                    Up
                  </span>
                </button>
                <button
                  type="button"
                  className="btn-small gap-1"
                  aria-label={`Move ${product.name} down`}
                  aria-disabled={readOnly || i === props.products.length - 1}
                  onClick={() => (readOnly || i === props.products.length - 1 ? undefined : props.onMove(product.id, "down"))}
                >
                  <Arrow up={false} />
                  <span aria-hidden="true" className="hidden sm:inline">
                    Down
                  </span>
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
