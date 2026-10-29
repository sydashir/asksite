// The HTML the sites Worker writes into the cart, sent and refusal shells (spec: .superpowers/phase2/shop/cart-markup.md,
// rev 4). PURE: it imports only the escaping template (html.ts), money, field and path constants, phone formatting, the
// title clip and a type. No design code, DOM, I/O, clock or randomness: the same input gives the same bytes.
// Every string input is untrusted text and goes through html``. Ids, slugs, the quote, money and the phone are checked by
// shape and THROW when wrong (a programming error of the caller, never buyer input).
import { clipText, fitsTitle } from "../clip.ts";
import { fragment, html, shopUrl, trusted, type SafeHtml } from "../html.ts";
import { formatPhone, telUrl } from "../phone.ts";
import { CART_FIELD, CART_OP, ORDER_FIELD, ORDER_MAX_LENGTH, REFILLED_FIELDS, type RefilledField } from "./fields.ts";
import { FULFILMENT, type Fulfilment } from "./model.ts";
import { formatUsd, lineCents, MAX_PRICE_CENTS } from "./money.ts";
import { isProductSlug, isRecordId } from "./paths.ts";

/** One priced cart line, built by the Worker from the cookie line + the version's Catalog (contract §3). */
export interface CartLineInput {
  readonly productId: string;
  readonly variantId?: string;
  readonly slug: string;
  readonly name: string;
  readonly variantLabel?: string;
  readonly unitCents: number;
  readonly compareAtCents?: number;
  readonly qty: number;
  readonly maxQty: number;
  readonly lineCents: number;
}

/** Cart notices the Worker raises (pages §1.4, §1.5); each maps to one fixed text. */
export type CartNotice = "added" | "updated" | "removed" | "items_removed" | "prices_changed";

/** Order-form errors after a POST /_o/<siteId> refusal that re-shows the form (pages §1.6 step 6). */
export type OrderErrorCode =
  | "required" | "too_long" | "name_invalid" | "email_invalid" | "phone_invalid" | "state_invalid" | "zip_invalid"
  | "fulfilment_invalid" | "address_required";
export interface OrderError {
  readonly field: RefilledField | "fulfilment";
  readonly code: OrderErrorCode;
}

/** The buyer's typed values to refill after an error. Never the honeypot, never the quote. */
export type OrderRefill = Partial<Record<RefilledField, string>> & { readonly fulfilment?: Fulfilment };

export interface CartSlotInput {
  readonly siteId: string;
  /** From the pointer (escaped). Blank (empty or whitespace) is read as absent: the pay note then says "The shop" (rev 4). */
  readonly businessName: string;
  readonly lines: readonly CartLineInput[];
  readonly subtotalCents: number;
  readonly notices?: readonly CartNotice[];
  readonly fulfilment: readonly Fulfilment[];
  readonly orderNote?: string;
  readonly quote: string;
  readonly refill?: OrderRefill;
  readonly errors?: readonly OrderError[];
}

export interface SentLineInput {
  readonly name: string;
  readonly variantLabel?: string;
  readonly qty: number;
  readonly lineCents: number;
}
export interface SentSlotInput {
  /** From the pointer (escaped). Blank is read as absent: the thank-you line then says "The shop" (rev 4). */
  readonly businessName: string;
  /** Present only with a valid signed order cookie; absent => the generic "Order received". */
  readonly order?: {
    readonly number: number;
    readonly lines: readonly SentLineInput[];
    readonly subtotalCents: number;
    readonly fulfilment: Fulfilment;
  };
}

/** Plain refusal pages with the business phone (pages §1.6 steps 4, 8, 9). */
export type RefusalReason = "rate_limited" | "orders_paused" | "daily_cap" | "order_too_large" | "cart_too_large" | "not_available";
export interface RefusalSlotInput {
  readonly reason: RefusalReason;
  /** Escaped; used in the title only. Blank is read as absent. */
  readonly businessName: string;
  /** E.164 as stored in facts. */
  readonly phone?: string;
}

// ---- Fixed texts (spec §5, §7): the only buyer-facing words this module writes -----------------------------------------

const NOTICE_ORDER: readonly CartNotice[] = ["added", "updated", "removed", "items_removed", "prices_changed"];
const NOTICE_TEXT: Readonly<Record<CartNotice, string>> = {
  added: "Added to your cart.",
  updated: "Your cart was updated.",
  removed: "Item removed.",
  items_removed: "Some items are no longer available and were removed.",
  prices_changed: "Prices or items changed. Please check your cart.",
};
const WARN_NOTICES: ReadonlySet<CartNotice> = new Set<CartNotice>(["items_removed", "prices_changed"]);

const LABEL: Readonly<Record<RefilledField, string>> = {
  name: "Your name",
  email: "Email",
  phone: "Phone (optional)",
  line1: "Address line 1",
  line2: "Address line 2 (optional)",
  city: "City",
  state: "State",
  zip: "ZIP code",
  note: "Note (optional)",
};
const NOUN: Readonly<Record<RefilledField, string>> = {
  name: "name",
  email: "email address",
  phone: "phone number",
  line1: "address line 1",
  line2: "address line 2",
  city: "city",
  state: "state",
  zip: "ZIP code",
  note: "note",
};
const FULFILMENT_LABEL: Readonly<Record<Fulfilment, string>> = { pickup: "Pickup", delivery: "Delivery", shipping: "Shipping" };
const FULFILMENT_SENT: Readonly<Record<Fulfilment, string>> = {
  pickup: "You chose pickup.",
  delivery: "You chose delivery.",
  shipping: "You chose shipping.",
};
const REFUSAL_TEXT: Readonly<Record<RefusalReason, string>> = {
  rate_limited: "Too many tries. Please wait a minute and try again.",
  orders_paused: "This shop is not taking orders online right now.",
  daily_cap: "This shop is not taking more online orders today.",
  order_too_large: "This order is too large to send online.",
  cart_too_large: "Your cart has too many items.",
  not_available: "Online orders are not available right now.",
};

/** What the sentences call the business when the pointer gave no name (rev 4; NEW text, for approval). */
const NAMELESS = "The shop";
const REFUSAL_HEADING = "Sorry, that did not go through";
const TITLE = { cart: "Your cart", sent: "Order received", refusal: "Order not sent" } as const;

const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function errorText({ field, code }: OrderError): string {
  switch (code) {
    case "required":
      return `Enter your ${NOUN[field as RefilledField]}`;
    case "too_long":
      return `${capitalised(NOUN[field as RefilledField])} is too long`;
    case "name_invalid":
      return "Enter your name without a web or email address";
    case "email_invalid":
      return "Enter an email address like name@example.com";
    case "phone_invalid":
      return "Enter a US phone number with area code, like (512) 555-0199";
    case "state_invalid":
      return "Enter the 2-letter state, like TX";
    case "zip_invalid":
      return "Enter a 5-digit ZIP code";
    case "fulfilment_invalid":
      return "Choose how you want to get your order";
    case "address_required":
      return "Enter your address, or choose pickup";
  }
}

// ---- Limits and shape checks (spec §2.5): a failure is the caller's bug, so it throws --------------------------------

const MAX_LINES = 20;
const MAX_QTY = 99;
const FIRST_ORDER_NUMBER = 1001;
const QUOTE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const PHONE_SHAPE = /^\+1[2-9]\d{2}[2-9]\d{6}$/; // site-schema's UsPhone rule
const ADDRESS_FIELDS: readonly RefilledField[] = ["line1", "line2", "city", "state", "zip"];
const FORM_ORDER: readonly (RefilledField | "fulfilment")[] = ["name", "email", "phone", "fulfilment", ...ADDRESS_FIELDS, "note"];

const fail = (what: string, value: unknown): never => {
  throw new Error(`cart-markup: ${what}: ${typeof value === "string" ? JSON.stringify(value.slice(0, 80)) : String(value)}`);
};
const checkText = (what: string, value: unknown): string => (typeof value === "string" ? value : fail(`${what} is not text`, value));
const checkInt = (what: string, value: unknown, min: number, max: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(`${what} is not a whole number from ${min} to ${max}`, value);
const checkCents = (what: string, value: unknown): number => checkInt(what, value, 1, MAX_PRICE_CENTS);
const checkSiteId = (siteId: unknown): string => (isRecordId(siteId) ? siteId : fail("invalid site id", siteId));
const checkFulfilment = (value: unknown): Fulfilment =>
  FULFILMENT.find((option) => option === value) ?? fail("invalid fulfilment", value);
const checkPhone = (phone: string): string => (PHONE_SHAPE.test(phone) ? phone : fail("phone is not a US E.164 number", phone));

function checkLine(line: CartLineInput): void {
  if (!isRecordId(line.productId)) fail("invalid product id", line.productId);
  if (!isProductSlug(line.slug)) fail("invalid product slug", line.slug);
  checkText("product name", line.name);
  if ((line.variantId === undefined) !== (line.variantLabel === undefined)) fail("variantId and variantLabel go together", line.variantId);
  if (line.variantId !== undefined && !isRecordId(line.variantId)) fail("invalid variant id", line.variantId);
  if (line.variantLabel !== undefined) checkText("variant label", line.variantLabel);
  checkCents("unit price", line.unitCents);
  if (line.compareAtCents !== undefined) checkCents("former price", line.compareAtCents);
  const maxQty = checkInt("maxQty", line.maxQty, 1, MAX_QTY);
  const qty = checkInt("qty", line.qty, 1, maxQty);
  if (lineCents(line.unitCents, qty) !== line.lineCents) fail("lineCents is not unitCents * qty", line.lineCents);
}

/** The sum of the lines' amounts; throws when it differs from `claimed`. */
function checkedSum(what: string, amounts: readonly number[], claimed: number): number {
  const sum = amounts.reduce((total, amount) => total + amount, 0);
  if (!Number.isSafeInteger(sum) || sum !== claimed) fail(`${what} is not the sum of its lines`, claimed);
  return sum;
}

function checkNotices(notices: readonly CartNotice[] | undefined): readonly CartNotice[] {
  const given = notices ?? [];
  const seen = new Set<CartNotice>();
  for (const notice of given) {
    if (!NOTICE_ORDER.includes(notice)) fail("unknown notice", notice);
    if (seen.has(notice)) fail("duplicate notice", notice);
    seen.add(notice);
  }
  return NOTICE_ORDER.filter((notice) => seen.has(notice));
}

/** The offered options in FULFILMENT order; throws on none, an unknown option or a repeat. */
function checkOffered(fulfilment: readonly Fulfilment[]): readonly Fulfilment[] {
  if (!Array.isArray(fulfilment) || fulfilment.length === 0) fail("no fulfilment option offered", fulfilment);
  const given = fulfilment.map(checkFulfilment);
  if (new Set(given).size !== given.length) fail("repeated fulfilment option", given.join(","));
  return FULFILMENT.filter((option) => given.includes(option));
}

const ONLY_FIELD: Readonly<Partial<Record<OrderErrorCode, RefilledField | "fulfilment">>> = {
  name_invalid: "name",
  email_invalid: "email",
  phone_invalid: "phone",
  state_invalid: "state",
  zip_invalid: "zip",
  fulfilment_invalid: "fulfilment",
};

/** Whether `code` can be reported on `field`. */
function codeFits(code: OrderErrorCode, field: RefilledField | "fulfilment"): boolean {
  if (code === "required" || code === "too_long") return field !== "fulfilment";
  if (code === "address_required") return ADDRESS_FIELDS.includes(field as RefilledField);
  return ONLY_FIELD[code] === field;
}

/** The errors in form order; throws on an unknown field, a code that does not fit its field, two errors for a field or an error on a field the form does not show. */
function checkErrors(errors: readonly OrderError[], showsAddress: boolean): readonly OrderError[] {
  const seen = new Set<string>();
  for (const { field, code } of errors) {
    if (!FORM_ORDER.includes(field)) fail("error on an unknown field", field);
    if (seen.has(field)) fail("two errors for one field", field);
    seen.add(field);
    if (!codeFits(code, field)) fail(`error code ${String(code)} does not fit the field`, field);
    if (!showsAddress && ADDRESS_FIELDS.includes(field as RefilledField)) fail("error on an address field the form does not show", field);
  }
  return FORM_ORDER.flatMap((field) => errors.filter((error) => error.field === field));
}

/** The refill: every typed value must be text; throws otherwise. */
function checkRefill(refill: OrderRefill | undefined): OrderRefill {
  const given = refill ?? {};
  for (const field of REFILLED_FIELDS) if (given[field] !== undefined) checkText(`refilled ${field}`, given[field]);
  if (given.fulfilment !== undefined) checkFulfilment(given.fulfilment);
  return given;
}

/** The business name as a sentence subject: the name, or "The shop" when it is blank. Throws unless it is text. */
const subject = (businessName: unknown): string => (checkText("business name", businessName).trim() === "" ? NAMELESS : (businessName as string));

/** A title: the fixed words, then " | <name>" clipped so the whole escaped title fits; just the fixed words when the name is blank. */
function titleOf(words: string, businessName: unknown): string {
  const name = checkText("business name", businessName);
  if (name.trim() === "") return words;
  const prefix = `${words} | `;
  return prefix + clipText(name, (clipped) => fitsTitle(prefix + clipped));
}

// ---- Small pieces ----------------------------------------------------------------------------------------------------

const money = (cents: number): string => formatUsd(cents, "exact");

const hidden = (text: string): SafeHtml => html`<span class="visually-hidden">${text}</span>`;

/** Owner text with its line breaks kept: one <br> per newline, every line escaped. */
function withBreaks(text: string): SafeHtml {
  const parts = text.split(/\r\n|\r|\n/).flatMap((line, i) => (i === 0 ? [line] : [trusted("<br>"), line]));
  return html`${parts}`;
}

function notices(shown: readonly CartNotice[]): readonly SafeHtml[] {
  return shown.map((notice) => {
    const warn = WARN_NOTICES.has(notice);
    return html`<p class="${warn ? "shop-notice shop-notice--warn" : "shop-notice"}" role="status">${NOTICE_TEXT[notice]}</p>`;
  });
}

function lineItem(line: CartLineInput, index: number): SafeHtml {
  const qtyId = `cart-qty-${index + 1}`;
  const was = line.compareAtCents !== undefined && line.compareAtCents > line.unitCents;
  const who = line.variantLabel === undefined ? ` ${line.name}` : ` ${line.name} ${line.variantLabel}`;
  const variant = line.variantId === undefined ? null : html`<input type="hidden" name="${CART_FIELD.variant}" value="${line.variantId}">`;
  const product = html`<input type="hidden" name="${CART_FIELD.product}" value="${line.productId}">`;
  return html`<li class="shop-line">
<a class="shop-line__name" href="${shopUrl({ product: line.slug })}">${line.name}</a>
${line.variantLabel === undefined ? null : html`<p class="shop-line__variant">${line.variantLabel}</p>`}
<p class="shop-line__unit">${money(line.unitCents)} each${was ? html` <s class="shop-line__was">Was ${money(line.compareAtCents ?? 0)}</s>` : null}</p>
<form class="shop-line__qty" method="post" action="${shopUrl("cartAction")}">
<input type="hidden" name="${CART_FIELD.op}" value="${CART_OP.set}">
${product}
${variant}
<label for="${qtyId}">Quantity${hidden(who)}</label>
<input id="${qtyId}" name="${CART_FIELD.qty}" type="text" inputmode="numeric" pattern="[0-9]*" value="${line.qty}" data-max="${line.maxQty}">
<button type="submit">Update${hidden(who)}</button>
</form>
<form class="shop-line__remove" method="post" action="${shopUrl("cartAction")}">
<input type="hidden" name="${CART_FIELD.op}" value="${CART_OP.remove}">
${product}
${variant}
<button type="submit">Remove${hidden(who)}</button>
</form>
<p class="shop-line__total">${hidden("Amount ")}${money(line.lineCents)}</p>
</li>`;
}

function subtotal(cents: number): SafeHtml {
  return html`<div class="shop-subtotal"><dl><dt>Subtotal</dt><dd>${money(cents)}</dd></dl></div>`;
}

// ---- The order form ----------------------------------------------------------------------------------------------------

interface FormState {
  readonly refill: OrderRefill;
  readonly errors: ReadonlyMap<string, OrderError>;
  readonly requiredAddress: boolean;
}

// Attributes that differ per field. Fixed literals from this file (never buyer text), so trusted() is safe.
const CONTROL_ATTRIBUTES: Readonly<Record<RefilledField, string>> = {
  name: 'type="text" autocomplete="name"',
  email: 'type="email" autocomplete="email"',
  phone: 'type="tel" autocomplete="tel"',
  line1: 'type="text" autocomplete="address-line1"',
  line2: 'type="text" autocomplete="address-line2"',
  city: 'type="text" autocomplete="address-level2"',
  state: 'type="text" autocomplete="address-level1" autocapitalize="characters"',
  zip: 'type="text" autocomplete="postal-code" inputmode="numeric"',
  note: "",
};

function isRequired(field: RefilledField, requiredAddress: boolean): boolean {
  if (field === "name" || field === "email") return true;
  return requiredAddress && (field === "line1" || field === "city" || field === "state" || field === "zip");
}

function field(name: RefilledField, state: FormState): SafeHtml {
  const id = `order-${name}`;
  const error = state.errors.get(name);
  const value = state.refill[name];
  // ids and names here come from the fixed field list, so these attribute strings hold no buyer text.
  const flags = trusted(
    `${isRequired(name, state.requiredAddress) ? " required" : ""}${error === undefined ? "" : ' aria-invalid="true"'}${error === undefined ? "" : ` aria-describedby="${id}-error"`}`,
  );
  const control =
    name === "note"
      ? // The parser drops one leading newline of a textarea, so a refilled value that starts with one keeps it.
        html`<textarea id="${id}" name="${ORDER_FIELD[name]}" rows="4" maxlength="${ORDER_MAX_LENGTH.note}"${flags}>
${typeof value === "string" ? value : null}</textarea>`
      : html`<input id="${id}" name="${ORDER_FIELD[name]}" ${trusted(CONTROL_ATTRIBUTES[name])} maxlength="${ORDER_MAX_LENGTH[name]}"${flags} value="${typeof value === "string" ? value : null}">`;
  return html`<div class="shop-field">
<label for="${id}">${LABEL[name]}</label>
${error === undefined ? null : html`<p class="shop-field__error" id="${id}-error">${hidden("Error: ")}${errorText(error)}</p>`}
${control}
</div>`;
}

function fulfilmentFieldset(offered: readonly Fulfilment[], state: FormState): SafeHtml {
  const error = state.errors.get("fulfilment");
  const described = error === undefined ? "" : ' aria-describedby="order-fulfilment-error"';
  const radios = offered.map((option) => {
    const checked = offered.length === 1 || state.refill.fulfilment === option;
    return html`<div><input type="radio" id="order-fulfilment-${option}" name="${ORDER_FIELD.fulfilment}" value="${option}" required${checked ? trusted(" checked") : null}><label for="order-fulfilment-${option}">${FULFILMENT_LABEL[option]}</label></div>`;
  });
  return html`<fieldset class="shop-fulfilment" id="order-fulfilment"${trusted(described)}>
<legend>How do you want to get your order?</legend>
${error === undefined ? null : html`<p class="shop-field__error" id="order-fulfilment-error">${hidden("Error: ")}${errorText(error)}</p>`}
${radios}
</fieldset>`;
}

function addressFieldset(pickupAlso: boolean, state: FormState): SafeHtml {
  return html`<fieldset class="shop-address"${pickupAlso ? trusted(' aria-describedby="order-address-hint"') : null}>
<legend>Address</legend>
${pickupAlso ? html`<p class="shop-field__hint" id="order-address-hint">Not needed for pickup.</p>` : null}
${ADDRESS_FIELDS.map((name) => field(name, state))}
</fieldset>`;
}

function errorSummary(errors: readonly OrderError[], offered: readonly Fulfilment[]): SafeHtml | null {
  if (errors.length === 0) return null;
  // GOV.UK: a radio group's summary link goes to its first radio, which is where focus can land.
  const target = (field: OrderError["field"]): string => (field === "fulfilment" ? `order-fulfilment-${offered[0]}` : `order-${field}`);
  const items = errors.map((error) => html`<li><a href="${fragment(target(error.field))}">${errorText(error)}</a></li>`);
  return html`<div class="shop-errors" role="alert" tabindex="-1">
<h2>There is a problem</h2>
<ul>${items}</ul>
</div>`;
}

function orderForm(input: CartSlotInput, offered: readonly Fulfilment[], errors: readonly OrderError[], refill: OrderRefill): SafeHtml {
  const pickupOnly = offered.length === 1 && offered[0] === "pickup";
  const pickupAlso = offered.includes("pickup") && offered.length > 1;
  const state: FormState = {
    refill,
    errors: new Map(errors.map((error) => [error.field, error])),
    requiredAddress: !offered.includes("pickup"),
  };
  return html`<form class="shop-order" id="order" method="post" action="${shopUrl({ order: input.siteId })}" enctype="application/x-www-form-urlencoded">
<h2 class="shop-order__title">Send your order</h2>
${field("name", state)}
${field("email", state)}
${field("phone", state)}
${fulfilmentFieldset(offered, state)}
${pickupOnly ? null : addressFieldset(pickupAlso, state)}
${field("note", state)}
<div class="shop-hp" aria-hidden="true"><label for="order-${ORDER_FIELD.honeypot}">Website</label><input id="order-${ORDER_FIELD.honeypot}" name="${ORDER_FIELD.honeypot}" tabindex="-1" autocomplete="off"></div>
<input type="hidden" name="${ORDER_FIELD.quote}" value="${input.quote}">
<button class="shop-order__send" type="submit">Send order</button>
</form>`;
}

// ---- The three slots ---------------------------------------------------------------------------------------------------

/** The cart page's slot: the empty cart, or the lines, the subtotal and the order form. */
export function renderCartSlot(input: CartSlotInput): string {
  const siteId = checkSiteId(input.siteId);
  const businessName = subject(input.businessName);
  if (!Array.isArray(input.lines) || input.lines.length > MAX_LINES) fail(`more than ${MAX_LINES} cart lines`, input.lines?.length);
  const shown = checkNotices(input.notices);
  const offered = checkOffered(input.fulfilment);
  input.lines.forEach(checkLine);
  checkedSum("subtotal", input.lines.map((line) => line.lineCents), input.subtotalCents);

  if (input.lines.length === 0) {
    return String(html`<div class="shop-cart-empty">
${notices(shown)}
<h1>Your cart is empty</h1>
<a href="${shopUrl("shop")}">See all products</a>
</div>`);
  }

  if (typeof input.quote !== "string" || !QUOTE_SHAPE.test(input.quote)) fail("invalid quote", input.quote);
  if (input.orderNote !== undefined) checkText("order note", input.orderNote);
  const pickupOnly = offered.length === 1 && offered[0] === "pickup";
  const errors = checkErrors(input.errors ?? [], !pickupOnly);
  const refill = checkRefill(input.refill);
  return String(html`<div class="shop-cart">
${notices(shown)}
${errorSummary(errors, offered)}
<h1 class="shop-cart__title">Your cart</h1>
<ul class="shop-lines">${input.lines.map(lineItem)}</ul>
${subtotal(input.subtotalCents)}
${input.orderNote === undefined || input.orderNote.trim() === "" ? null : html`<div class="shop-order-note">${withBreaks(input.orderNote)}</div>`}
<p class="shop-paynote">You pay nothing now. ${businessName} will contact you to confirm your order, payment and how you get it.</p>
${orderForm(input, offered, errors, refill)}
</div>`);
}

function sentLine(line: SentLineInput): SafeHtml {
  checkText("product name", line.name);
  if (line.variantLabel !== undefined) checkText("variant label", line.variantLabel);
  checkInt("qty", line.qty, 1, MAX_QTY);
  checkInt("line amount", line.lineCents, 1, Number.MAX_SAFE_INTEGER);
  return html`<li class="shop-line">
<span class="shop-line__name">${line.name}</span>
${line.variantLabel === undefined ? null : html`<p class="shop-line__variant">${line.variantLabel}</p>`}
<p class="shop-line__count">Quantity: ${line.qty}</p>
<p class="shop-line__total">${hidden("Amount ")}${money(line.lineCents)}</p>
</li>`;
}

function sentOrder(order: NonNullable<SentSlotInput["order"]>): SafeHtml {
  checkInt("order number", order.number, FIRST_ORDER_NUMBER, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(order.lines) || order.lines.length < 1 || order.lines.length > MAX_LINES) fail(`an order holds 1 to ${MAX_LINES} lines`, order.lines?.length);
  const lines = order.lines.map(sentLine);
  checkedSum("subtotal", order.lines.map((line) => line.lineCents), order.subtotalCents);
  const fulfilment = checkFulfilment(order.fulfilment);
  return html`<p class="shop-sent__number">Order number ${order.number}</p>
<ul class="shop-lines">${lines}</ul>
${subtotal(order.subtotalCents)}
<p class="shop-sent__fulfilment">${FULFILMENT_SENT[fulfilment]}</p>`;
}

/** The sent page's slot: the thank-you, and with a valid order its number, lines, subtotal and fulfilment. Never the buyer's details. */
export function renderSentSlot(input: SentSlotInput): string {
  const businessName = subject(input.businessName);
  return String(html`<div class="shop-sent">
<h1>Order received</h1>
<p>Thank you. ${businessName} has your order and will contact you.</p>
${input.order === undefined ? null : sentOrder(input.order)}
</div>`);
}

/** A refusal page's slot: one fixed sentence per reason, and the business phone when given. */
export function renderRefusalSlot(input: RefusalSlotInput): string {
  const sentence = Object.hasOwn(REFUSAL_TEXT, input.reason) ? REFUSAL_TEXT[input.reason] : fail("unknown refusal reason", input.reason);
  checkText("business name", input.businessName);
  const phone = input.phone === undefined ? undefined : checkPhone(input.phone);
  return String(html`<div class="shop-refusal">
<h1>${REFUSAL_HEADING}</h1>
<p>${sentence}</p>
${phone === undefined ? null : html`<p>Please call <a href="${telUrl(phone)}">${formatPhone(phone)}</a>.</p>`}
</div>`);
}

// ---- Titles: raw text for the Worker to set (it escapes) ---------------------------------------------------------------

/** "Your cart | <name>", prefixed "Error: " after an order error; the name is clipped so the escaped title is at most 70 characters. */
export function cartPageTitle(businessName: string, opts: { readonly hasErrors: boolean }): string {
  return titleOf(`${opts.hasErrors ? "Error: " : ""}${TITLE.cart}`, businessName);
}

/** "Order received | <name>". */
export function sentPageTitle(businessName: string): string {
  return titleOf(TITLE.sent, businessName);
}

/** "Order not sent | <name>". */
export function refusalPageTitle(businessName: string): string {
  return titleOf(TITLE.refusal, businessName);
}
