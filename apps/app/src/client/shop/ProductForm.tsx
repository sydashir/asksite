import { isSafeUrl } from "@asksite/site-schema";
import { Checkbox, TextArea, TextInput } from "../components/fields.tsx";
import { formatUsd, parseUsdCents } from "../lib/money.ts";
import { fieldId } from "../lib/values.ts";
import { choiceName, PRODUCT_LIMITS, slugFromName, syncVariants, variantsProblem, type ProductDraft, type ProductOptionDraft, type ProductPath, type VariantDraft } from "./catalog.ts";
import { OptionValues } from "./OptionValues.tsx";
import { PriceInput } from "./PriceInput.tsx";

interface Props {
  product: ProductDraft;
  onChange: (product: ProductDraft) => void;
  errors: (path: ProductPath) => readonly string[];
  /** "Was" prices are allowed only after the client's confirmation (shop settings, FTC 16 CFR 233.1). */
  formerPricesConfirmed: boolean;
  /** The product is on the live site: changing its link breaks links people already have. */
  published: boolean;
  /** How many one buyer may order when the product sets no limit. */
  defaultMaxQty: number;
  onAddPhotos: (files: File[]) => void;
  /** The upload's progress or result, said by the container ("Uploading 2 photos…", "2 photos added."). */
  photoStatus: string;
  onBack: () => void;
  onDelete: () => void;
  readOnly?: boolean;
}

const id = (path: ProductPath) => fieldId(["product", ...path]);

/**
 * One product: its name and link, price and optional "was" price, photos, description, sizes and colours with a price and a
 * sold-out mark for each combination, and the most one buyer can order. Every number is kept as typed; the container parses
 * it (parseUsdCents) and sends the errors back through `errors`.
 */
export function ProductForm(props: Props) {
  const { product } = props;
  const readOnly = props.readOnly === true;
  const set = (patch: Partial<ProductDraft>) => props.onChange({ ...product, ...patch });
  const setOptions = (options: ProductOptionDraft[]) => set({ options, variants: syncVariants(options, product.variants) });
  const setVariant = (index: number, patch: Partial<VariantDraft>) => set({ variants: product.variants.map((v, i) => (i === index ? { ...v, ...patch } : v)) });
  const basePrice = parseUsdCents(product.priceText);
  const baseText = basePrice.ok ? formatUsd(basePrice.cents, "short") : "the product's price";
  const suggested = slugFromName(product.name);
  const title = product.name.trim() === "" ? "New product" : product.name;
  const rowsProblem = variantsProblem(product.variants);
  const photosFull = product.photos.length >= PRODUCT_LIMITS.photos;

  return (
    <section aria-labelledby="product-title">
      <button type="button" className="link back-link" onClick={props.onBack}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        All products
      </button>
      <h2 id="product-title" className="section-title mt-2 break-words">
        {title}
      </h2>

      <TextInput id={id(["name"])} label="Name" value={product.name} max={PRODUCT_LIMITS.name} readOnly={readOnly} errors={props.errors(["name"])} onChange={(name) => set({ name })} />
      <TextInput
        id={id(["slug"])}
        label="Link to this product"
        hint={`Lower-case letters, numbers and single dashes. The page is at /shop/${product.slug || "…"}.`}
        value={product.slug}
        readOnly={readOnly}
        spellCheck={false}
        errors={props.errors(["slug"])}
        onChange={(slug) => set({ slug })}
        after={
          <>
            {props.published ? <p className="mt-1 text-sm text-slate-700">This product is live. A new link breaks links people already have.</p> : null}
            {product.name.trim() !== "" && suggested !== product.slug ? (
              <button type="button" className="btn-small mt-2" aria-disabled={readOnly} onClick={() => (readOnly ? undefined : set({ slug: suggested }))}>
                Use “{suggested}”
              </button>
            ) : null}
          </>
        }
      />

      <PriceInput
        id={id(["price"])}
        label="Price in US dollars"
        {...(product.variants.length > 0 ? { hint: "Choices without their own price use this one." } : {})}
        value={product.priceText}
        readOnly={readOnly}
        errors={props.errors(["price"])}
        onChange={(priceText) => set({ priceText })}
      />
      {props.formerPricesConfirmed ? (
        <PriceInput
          id={id(["compareAt"])}
          label="“Was” price in US dollars"
          optional
          hint="A price the client really charged before. The website shows it crossed out beside the price."
          emptyText="No “was” price is shown."
          value={product.compareAtText}
          readOnly={readOnly}
          errors={props.errors(["compareAt"])}
          onChange={(compareAtText) => set({ compareAtText })}
        />
      ) : (
        <p className="mt-3 text-sm text-slate-600">“Was” prices are off. They can be turned on in Shop settings once the client confirms they really charged those prices.</p>
      )}

      <fieldset id={id(["photos"])} tabIndex={-1} className="mt-6 min-w-0">
        <legend className="font-medium text-ink">Photos</legend>
        <p className="mt-1 text-sm text-slate-600">Up to {PRODUCT_LIMITS.photos}. The first one is the main photo in the shop.</p>
        {product.photos.length === 0 ? <p className="mt-2 text-slate-700">No photos yet. The shop shows a simple picture-free card until one is added.</p> : null}
        <ol className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {product.photos.map((photo, i) => (
            <li key={photo.upload} className="photo-card">
              <div className="flex items-start gap-3">
                {isSafeUrl(photo.url, ["https:"]) ? <img src={photo.url} alt="" className="thumb thumb-lg" /> : <span aria-hidden="true" className="thumb thumb-lg" />}
                <div className="min-w-0">
                  <p className="font-medium text-ink">Photo {i + 1}</p>
                  {i === 0 ? <p className="pill-brand mt-1">Main photo</p> : null}
                </div>
              </div>
              <TextInput
                id={id(["photos", i, "alt"])}
                label={`Describe photo ${i + 1}`}
                optional
                hint="What it shows, for people who can't see it. Leave empty to use the product's name."
                value={photo.alt}
                max={PRODUCT_LIMITS.alt}
                readOnly={readOnly}
                errors={props.errors(["photos", i, "alt"])}
                onChange={(alt) => set({ photos: product.photos.map((p, j) => (j === i ? { ...p, alt } : p)) })}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {i > 0 ? (
                  <button
                    type="button"
                    className="btn-small"
                    aria-disabled={readOnly}
                    onClick={() => (readOnly ? undefined : set({ photos: [photo, ...product.photos.filter((_, j) => j !== i)] }))}
                  >
                    Make photo {i + 1} the main photo
                  </button>
                ) : null}
                <button type="button" className="btn-small" aria-disabled={readOnly} onClick={() => (readOnly ? undefined : set({ photos: product.photos.filter((_, j) => j !== i) }))}>
                  Remove photo {i + 1}
                </button>
              </div>
            </li>
          ))}
        </ol>
        <label htmlFor={id(["photos", "add"])} className="mt-4 block font-medium text-ink">
          Add photos
        </label>
        <p id={`${id(["photos", "add"])}-hint`} className="mt-1 text-sm text-slate-600">
          {photosFull ? `This product has ${PRODUCT_LIMITS.photos} photos, the most it can have. Remove one to add another.` : "JPG, PNG or WebP. You can pick several at once."}
        </p>
        <input
          id={id(["photos", "add"])}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          className="mt-1.5 block max-w-full text-slate-700"
          disabled={readOnly || photosFull}
          aria-describedby={`${id(["photos", "add"])}-hint`}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length > 0) props.onAddPhotos(files);
          }}
        />
        <p role="status" className="mt-2 text-sm text-slate-700">
          {props.photoStatus}
        </p>
        {props.errors(["photos"]).length > 0 ? <p className="mt-1 text-sm font-medium text-red-700">{props.errors(["photos"]).join(" ")}</p> : null}
      </fieldset>

      <TextArea
        id={id(["description"])}
        label="Description"
        optional
        hint="In the client's words. The AI never adds to it."
        rows={5}
        value={product.description}
        max={PRODUCT_LIMITS.description}
        readOnly={readOnly}
        errors={props.errors(["description"])}
        onChange={(description) => set({ description })}
      />

      <fieldset className="mt-6 min-w-0">
        <legend className="font-medium text-ink">Sizes and colours</legend>
        <p className="mt-1 text-sm text-slate-600">
          Up to {PRODUCT_LIMITS.options} lists, like Size and Colour, with up to {PRODUCT_LIMITS.optionValues} choices each.
        </p>
        {product.options.map((option, i) => (
          <div key={i} className="option-box">
            <TextInput
              id={id(["options", i, "name"])}
              label={`Name of list ${i + 1}`}
              hint="For example Size or Colour."
              value={option.name}
              max={20}
              readOnly={readOnly}
              errors={props.errors(["options", i, "name"])}
              onChange={(name) => setOptions(product.options.map((o, j) => (j === i ? { ...o, name } : o)))}
            />
            <OptionValues
              id={id(["options", i, "values"])}
              name={option.name}
              values={option.values}
              readOnly={readOnly}
              errors={props.errors(["options", i, "values"])}
              onChange={(values) => setOptions(product.options.map((o, j) => (j === i ? { ...o, values } : o)))}
            />
            <button type="button" className="btn-small mt-4" aria-disabled={readOnly} onClick={() => (readOnly ? undefined : setOptions(product.options.filter((_, j) => j !== i)))}>
              Remove the {option.name.trim() || `list ${i + 1}`} list
            </button>
          </div>
        ))}
        {product.options.length < PRODUCT_LIMITS.options ? (
          <button
            type="button"
            className="btn-secondary mt-4"
            aria-disabled={readOnly}
            onClick={() => (readOnly ? undefined : setOptions([...product.options, { name: product.options.length === 0 ? "Size" : "Colour", values: [] }]))}
          >
            {product.options.length === 0 ? "Add sizes or colours" : "Add another list, like Colour"}
          </button>
        ) : null}

        {product.variants.length > 0 ? (
          <div className="mt-6">
            <h3 id="choices-title" className="font-semibold text-ink">
              What buyers can choose
            </h3>
            <p id="choices-hint" className="mt-1 text-sm text-slate-600">
              Untick a choice the shop doesn't sell. Leave a price empty to use {baseText}.
            </p>
            {rowsProblem !== null ? <p className="mt-1 text-sm font-medium text-red-700">{rowsProblem}</p> : null}
            <div className="table-scroll mt-3" role="region" aria-labelledby="choices-title" tabIndex={0}>
              <table className={props.formerPricesConfirmed ? "data-table min-w-[36rem]" : "data-table min-w-[29rem]"}>
                <thead>
                  <tr>
                    <th scope="col">Choice</th>
                    <th scope="col">Sold here</th>
                    <th scope="col">Price</th>
                    {props.formerPricesConfirmed ? <th scope="col">“Was” price</th> : null}
                    <th scope="col">Sold out</th>
                  </tr>
                </thead>
                <tbody>
                  {product.variants.map((variant, i) => {
                    const name = choiceName(product.options, variant.values);
                    return (
                      <tr key={variant.values.join("\u0000")}>
                        <th scope="row" className="break-words">
                          {name}
                        </th>
                        <td>
                          <input
                            id={id(["variants", i, "offered"])}
                            type="checkbox"
                            className="size-6 accent-brand-800"
                            checked={variant.offered}
                            disabled={readOnly}
                            onChange={(e) => setVariant(i, { offered: e.target.checked })}
                          />
                          <label htmlFor={id(["variants", i, "offered"])} className="sr-only">
                            {name} is sold here
                          </label>
                        </td>
                        <td className="min-w-32">
                          {variant.offered ? (
                            <PriceInput
                              compact
                              id={id(["variants", i, "price"])}
                              label={`Price for ${name}`}
                              optional
                              value={variant.priceText}
                              readOnly={readOnly}
                              errors={props.errors(["variants", i, "price"])}
                              onChange={(priceText) => setVariant(i, { priceText })}
                            />
                          ) : (
                            <span className="text-sm text-slate-600">Not sold</span>
                          )}
                        </td>
                        {props.formerPricesConfirmed ? (
                          <td className="min-w-32">
                            {variant.offered ? (
                              <PriceInput
                                compact
                                id={id(["variants", i, "compareAt"])}
                                label={`“Was” price for ${name}`}
                                optional
                                value={variant.compareAtText}
                                readOnly={readOnly}
                                errors={props.errors(["variants", i, "compareAt"])}
                                onChange={(compareAtText) => setVariant(i, { compareAtText })}
                              />
                            ) : null}
                          </td>
                        ) : null}
                        <td>
                          {variant.offered ? (
                            <>
                              <input
                                id={id(["variants", i, "soldOut"])}
                                type="checkbox"
                                className="size-6 accent-brand-800"
                                checked={variant.soldOut}
                                disabled={readOnly}
                                onChange={(e) => setVariant(i, { soldOut: e.target.checked })}
                              />
                              <label htmlFor={id(["variants", i, "soldOut"])} className="sr-only">
                                {name} is sold out
                              </label>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </fieldset>

      <Checkbox
        id={id(["soldOut"])}
        label="The whole product is sold out"
        hint="Buyers see “Sold out” and can't order it."
        checked={product.soldOut}
        errors={props.errors(["soldOut"])}
        onChange={(soldOut) => (readOnly ? undefined : set({ soldOut }))}
      />
      <div className="narrow-field">
        <TextInput
          id={id(["maxQty"])}
          label="Most one buyer can order at once"
          optional
          hint={`A number from 1 to ${PRODUCT_LIMITS.maxQty}. Leave empty for ${props.defaultMaxQty}.`}
          inputMode="numeric"
          value={product.maxQtyText}
          readOnly={readOnly}
          errors={props.errors(["maxQty"])}
          onChange={(maxQtyText) => set({ maxQtyText })}
        />
      </div>

      <div className="mt-8 border-t border-slate-200 pt-6">
        <button type="button" className="btn-danger" aria-disabled={readOnly} onClick={() => (readOnly ? undefined : props.onDelete())}>
          Delete this product
        </button>
      </div>
    </section>
  );
}
