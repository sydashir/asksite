import { parseFragment } from "parse5";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../../fixtures/index.ts";
import { escapeText } from "../../src/escape.ts";
import {
  cartPageTitle,
  refusalPageTitle,
  renderCartSlot,
  renderRefusalSlot,
  renderSentSlot,
  sentPageTitle,
  type CartLineInput,
  type CartNotice,
  type CartSlotInput,
  type OrderError,
  type OrderErrorCode,
  type RefusalReason,
  type SentSlotInput,
} from "../../src/shop/cart-markup.ts";
import { CART_FIELD, CART_OP, ORDER_FIELD, ORDER_MAX_LENGTH, REFILLED_FIELDS, type RefilledField } from "../../src/shop/fields.ts";
import { FULFILMENT, type Fulfilment } from "../../src/shop/model.ts";

// ---- A small parse5 view of the output (structure, never regexes alone) ---------------------------------------------

interface Node {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly attrs?: readonly { name: string; value: string }[];
  readonly childNodes?: readonly Node[];
  readonly value?: string;
}
const walk = (node: Node, out: Node[] = []): Node[] => {
  out.push(node);
  for (const child of node.childNodes ?? []) walk(child, out);
  return out;
};
const dom = (markup: string): Node[] => walk(parseFragment(markup) as unknown as Node);
const attr = (node: Node | undefined, name: string): string | undefined => node?.attrs?.find((a) => a.name === name)?.value;
const hasClass = (node: Node, name: string): boolean => (attr(node, "class") ?? "").split(" ").includes(name);
const textOf = (node: Node): string => (node.nodeName === "#text" ? (node.value ?? "") : (node.childNodes ?? []).map(textOf).join(""));
const byClass = (nodes: Node[], name: string): Node[] => nodes.filter((n) => hasClass(n, name));
const byTag = (nodes: Node[], tag: string): Node[] => nodes.filter((n) => n.tagName === tag);
const byId = (nodes: Node[], id: string): Node | undefined => nodes.find((n) => attr(n, "id") === id);
const control = (nodes: Node[], name: string): Node | undefined => nodes.find((n) => (n.tagName === "input" || n.tagName === "textarea") && attr(n, "name") === name);
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The only elements this module writes. An injected <img>, <b>, <iframe> or <script> is not among them. */
const ALLOWED = new Set(["div", "p", "h1", "h2", "ul", "li", "a", "s", "span", "form", "input", "label", "button", "dl", "dt", "dd", "fieldset", "legend", "textarea", "br"]);
/** Nothing that runs script, styles inline or comes from an injection: elements, attributes and URLs. */
function activeContent(markup: string): string[] {
  const nodes = dom(markup);
  const problems: string[] = [];
  for (const node of nodes) {
    if (node.nodeName === "#comment") problems.push("comment");
    if (node.tagName !== undefined && !ALLOWED.has(node.tagName)) problems.push(`element <${node.tagName}>`);
    for (const a of node.attrs ?? []) {
      if (/^on/i.test(a.name)) problems.push(`handler ${a.name}`);
      if (a.name === "style") problems.push("style attribute");
      if (/javascript:/i.test(a.value) && ["href", "action", "src"].includes(a.name)) problems.push(`javascript: in ${a.name}`);
    }
  }
  return problems;
}

// ---- Inputs ---------------------------------------------------------------------------------------------------------

const SITE = "11111111-1111-4111-8111-111111111111";
const PROD = "22222222-2222-4222-8222-222222222222";
const VAR = "33333333-3333-4333-8333-333333333333";
const PROD2 = "44444444-4444-4444-8444-444444444444";
const QUOTE = "abcdefABCDEF0123456789_-xyz";
const PHONE = "+15125550199";

const line = (over: Partial<CartLineInput> = {}): CartLineInput => ({
  productId: PROD, slug: "blue-mug", name: "Blue mug", unitCents: 1250, qty: 2, maxQty: 10, lineCents: 2500, ...over,
});
const variantLine = (over: Partial<CartLineInput> = {}): CartLineInput => line({ variantId: VAR, variantLabel: "M / Blue", ...over });
const cart = (over: Partial<CartSlotInput> = {}): CartSlotInput => ({
  siteId: SITE, businessName: "Acme Pottery", lines: [line()], subtotalCents: 2500, fulfilment: ["pickup", "delivery"], quote: QUOTE, ...over,
});
const render = (over: Partial<CartSlotInput> = {}): string => renderCartSlot(cart(over));
const sent = (over: Partial<SentSlotInput> = {}): SentSlotInput => ({
  businessName: "Acme Pottery",
  order: { number: 1001, lines: [{ name: "Blue mug", qty: 2, lineCents: 2500 }], subtotalCents: 2500, fulfilment: "pickup" },
  ...over,
});

/** The hostile strings: the XSS payloads of the electrical-xss fixture (the cases of test/xss.test.ts), plus the shop's own. */
function fixturePayloads(): string[] {
  const out = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (/[<>"&']|javascript:|onerror|onload/i.test(value)) out.add(value);
    } else if (value !== null && typeof value === "object") for (const v of Object.values(value)) visit(v);
  };
  visit(loadFixture("electrical-xss"));
  return [...out];
}
const PAYLOADS: readonly string[] = [
  ...fixturePayloads(),
  `'" <>&`,
  "' onmouseover='alert(1)",
  "&lt;script&gt; &amp; &#60;",
  "</textarea><script>alert(1)</script>",
  "</title><script>alert(1)</script>",
  "‮gnp.exe‬ ​‍﻿ zero-width",
  `${"A".repeat(5000)}<script>alert(1)</script>`,
];

const ERROR_FIELDS: readonly (RefilledField | "fulfilment")[] = ["name", "email", "phone", "fulfilment", "line1", "line2", "city", "state", "zip", "note"];

// ---- Escaping --------------------------------------------------------------------------------------------------------

describe("escaping: every string input is text, in text and attribute contexts", () => {
  it("has enough payloads to mean something", () => {
    expect(PAYLOADS.length).toBeGreaterThanOrEqual(25);
  });

  it.each(PAYLOADS.map((p, i) => [i, p] as const))("product name and variant label (payload %i)", (_i, payload) => {
    const out = render({ lines: [variantLine({ name: payload, variantLabel: payload })] });
    expect(activeContent(out)).toEqual([]);
    const nodes = dom(out);
    expect(textOf(byClass(nodes, "shop-line__name")[0]!)).toBe(payload);
    expect(textOf(byClass(nodes, "shop-line__variant")[0]!)).toBe(payload);
    expect(textOf(byTag(nodes, "button")[1]!)).toBe(`Remove ${payload} ${payload}`);
  });

  it.each(PAYLOADS.map((p, i) => [i, p] as const))("order note (payload %i)", (_i, payload) => {
    const out = render({ orderNote: payload });
    expect(activeContent(out)).toEqual([]);
    expect(textOf(byClass(dom(out), "shop-order-note")[0]!)).toBe(payload);
  });

  it.each(PAYLOADS.map((p, i) => [i, p] as const))("business name in the pay note, the sent page and the refusal title (payload %i)", (_i, payload) => {
    const out = render({ businessName: payload });
    expect(activeContent(out)).toEqual([]);
    expect(textOf(byClass(dom(out), "shop-paynote")[0]!)).toBe(`You pay nothing now. ${payload} will contact you to confirm your order, payment and how you get it.`);
    const page = renderSentSlot(sent({ businessName: payload }));
    expect(activeContent(page)).toEqual([]);
    expect(squash(textOf(byClass(dom(page), "shop-sent")[0]!))).toContain(squash(`Thank you. ${payload} has your order and will contact you.`));
    expect(activeContent(renderRefusalSlot({ reason: "rate_limited", businessName: payload, phone: PHONE }))).toEqual([]);
  });

  // Each refilled field on its own: a payload in one field must not need another field to be escaped.
  describe.each(REFILLED_FIELDS)("the refilled %s field", (field) => {
    it.each(PAYLOADS.map((p, i) => [i, p] as const))("payload %i round-trips as the value", (_i, payload) => {
      const out = render({ refill: { [field]: payload } });
      expect(activeContent(out)).toEqual([]);
      const nodes = dom(out);
      const element = control(nodes, field);
      expect(element).toBeDefined();
      if (field === "note") expect(textOf(element!)).toBe(payload);
      else expect(attr(element, "value")).toBe(payload);
      // and no other field took it
      for (const other of REFILLED_FIELDS.filter((f) => f !== field)) {
        const el = control(nodes, other);
        expect(other === "note" ? textOf(el!) : attr(el, "value")).toBe("");
      }
    });
  });

  it("keeps a refilled note's leading newline and its line breaks", () => {
    const note = render({ refill: { note: "\nfirst\nsecond" } });
    expect(textOf(control(dom(note), "note")!)).toBe("\nfirst\nsecond");
  });

  it("shows the order note's line breaks as <br>, each line escaped", () => {
    const out = render({ orderNote: "one <b>\ntwo\r\nthree" });
    const note = byClass(dom(out), "shop-order-note")[0]!;
    expect(byTag(walk(note), "br")).toHaveLength(2);
    expect(squash(textOf(note))).toBe("one <b>twothree");
    expect(activeContent(out)).toEqual([]);
  });

  it("escapes ids and values that must be shaped: an unsafe slug or id never reaches the markup (it throws)", () => {
    expect(() => render({ lines: [line({ slug: '"><script>' })] })).toThrow();
    expect(() => render({ lines: [line({ productId: '"><script>' })] })).toThrow();
    expect(() => render({ quote: '"><script>alert(1)</script>' })).toThrow();
  });

  it("the quote is written only from input.quote, and a refill cannot reach it, the honeypot or fulfilment's name", () => {
    const refill = { quote: "tampered-tampered-tampered", website: "i-am-a-bot", fulfilment: "delivery" } as never;
    const nodes = dom(render({ refill }));
    expect(attr(control(nodes, ORDER_FIELD.quote), "value")).toBe(QUOTE);
    expect(attr(control(nodes, ORDER_FIELD.honeypot), "value")).toBeUndefined();
    expect(JSON.stringify(nodes.flatMap((n) => n.attrs ?? []))).not.toContain("tampered");
    expect(JSON.stringify(nodes.flatMap((n) => n.attrs ?? []))).not.toContain("i-am-a-bot");
  });

  it("escapes the sent page's product name and variant label", () => {
    for (const payload of PAYLOADS) {
      const out = renderSentSlot(sent({ order: { number: 1002, lines: [{ name: payload, variantLabel: payload, qty: 1, lineCents: 500 }], subtotalCents: 500, fulfilment: "delivery" } }));
      expect(activeContent(out)).toEqual([]);
      expect(textOf(byClass(dom(out), "shop-line__name")[0]!)).toBe(payload);
      expect(textOf(byClass(dom(out), "shop-line__variant")[0]!)).toBe(payload);
    }
  });
});

// ---- Shape -----------------------------------------------------------------------------------------------------------

describe("shape of the cart slot", () => {
  const out = render({
    lines: [variantLine({ compareAtCents: 1500 }), line({ productId: PROD2, slug: "red-bowl", name: "Red bowl", unitCents: 900, qty: 1, lineCents: 900 })],
    subtotalCents: 3400,
    notices: ["added"],
    orderNote: "Pickup Saturdays.",
  });
  const nodes = dom(out);

  it("posts the order form urlencoded to /_o/<siteId> with exactly the order fields", () => {
    const form = byTag(nodes, "form").find((f) => attr(f, "id") === "order")!;
    expect(attr(form, "method")).toBe("post");
    expect(attr(form, "action")).toBe(`/_o/${SITE}`);
    expect(attr(form, "enctype")).toBe("application/x-www-form-urlencoded");
    expect(attr(form, "novalidate")).toBeUndefined();
    const names = walk(form).filter((n) => n.tagName === "input" || n.tagName === "textarea").map((n) => attr(n, "name"));
    expect(new Set(names)).toEqual(new Set([...REFILLED_FIELDS, "fulfilment", "website", "quote"]));
    expect(names.filter((n) => n === "fulfilment")).toHaveLength(2);
  });

  it("posts each line's set and remove forms to /_cart with op, product and variant", () => {
    const sets = byClass(nodes, "shop-line__qty");
    const removes = byClass(nodes, "shop-line__remove");
    expect(sets).toHaveLength(2);
    expect(removes).toHaveLength(2);
    const fieldsOf = (form: Node) => Object.fromEntries(walk(form).filter((n) => n.tagName === "input").map((n) => [attr(n, "name"), attr(n, "value")]));
    for (const form of [...sets, ...removes]) {
      expect(attr(form, "method")).toBe("post");
      expect(attr(form, "action")).toBe("/_cart");
    }
    expect(fieldsOf(sets[0]!)).toMatchObject({ [CART_FIELD.op]: CART_OP.set, [CART_FIELD.product]: PROD, [CART_FIELD.variant]: VAR, [CART_FIELD.qty]: "2" });
    expect(fieldsOf(removes[0]!)).toMatchObject({ [CART_FIELD.op]: CART_OP.remove, [CART_FIELD.product]: PROD, [CART_FIELD.variant]: VAR });
    expect(fieldsOf(sets[1]!)).toEqual({ [CART_FIELD.op]: CART_OP.set, [CART_FIELD.product]: PROD2, [CART_FIELD.qty]: "1" });
    expect(fieldsOf(removes[1]!)).toEqual({ [CART_FIELD.op]: CART_OP.remove, [CART_FIELD.product]: PROD2 });
  });

  it("writes the qty input as the spec says, with data-max and a label", () => {
    const qty = control(nodes, "qty")!;
    expect(attr(qty, "type")).toBe("text");
    expect(attr(qty, "inputmode")).toBe("numeric");
    expect(attr(qty, "pattern")).toBe("[0-9]*");
    expect(attr(qty, "value")).toBe("2");
    expect(attr(qty, "data-max")).toBe("10");
    expect(byTag(nodes, "label").some((l) => attr(l, "for") === attr(qty, "id") && textOf(l) === "Quantity Blue mug M / Blue")).toBe(true);
  });

  it("links each line to /shop/<slug>", () => {
    expect(byClass(nodes, "shop-line__name").map((a) => attr(a, "href"))).toEqual(["/shop/blue-mug", "/shop/red-bowl"]);
  });

  it("keeps the honeypot out of the tab order and away from assistive tech, and never refills it", () => {
    const wrapper = byClass(nodes, "shop-hp")[0]!;
    expect(attr(wrapper, "aria-hidden")).toBe("true");
    const input = control(walk(wrapper), "website")!;
    expect(attr(input, "tabindex")).toBe("-1");
    expect(attr(input, "autocomplete")).toBe("off");
    expect(attr(input, "value")).toBeUndefined();
  });

  it("has a hidden quote and a send button that never says checkout or pay", () => {
    const quote = control(nodes, "quote")!;
    expect(attr(quote, "type")).toBe("hidden");
    expect(attr(quote, "value")).toBe(QUOTE);
    const send = byClass(nodes, "shop-order__send")[0]!;
    expect(textOf(send)).toBe("Send order");
    expect(out).not.toMatch(/checkout/i);
  });

  it("writes the field controls with their autocomplete, types and limits", () => {
    const expected: Record<string, [string | undefined, string | undefined]> = {
      name: ["text", "name"], email: ["email", "email"], phone: ["tel", "tel"], line1: ["text", "address-line1"], line2: ["text", "address-line2"],
      city: ["text", "address-level2"], state: ["text", "address-level1"], zip: ["text", "postal-code"],
    };
    for (const [name, [type, autocomplete]] of Object.entries(expected)) {
      const el = control(nodes, name)!;
      expect([attr(el, "type"), attr(el, "autocomplete")]).toEqual([type, autocomplete]);
      expect(attr(el, "maxlength")).toBe(String(ORDER_MAX_LENGTH[name as RefilledField]));
    }
    expect(attr(control(nodes, "state"), "autocapitalize")).toBe("characters");
    expect(attr(control(nodes, "zip"), "inputmode")).toBe("numeric");
    expect(control(nodes, "note")!.tagName).toBe("textarea");
    expect(attr(control(nodes, "note"), "maxlength")).toBe("1000");
  });

  it("has unique ids, and every label points at an existing control", () => {
    const ids = nodes.map((n) => attr(n, "id")).filter((id): id is string => id !== undefined);
    expect(new Set(ids).size).toBe(ids.length);
    for (const label of byTag(nodes, "label")) expect(byId(nodes, attr(label, "for")!)).toBeDefined();
  });

  it("never writes the word total, a script, a handler, an inline style or a javascript: link", () => {
    expect(out).not.toMatch(/\btotal\b/i);
    expect(out).not.toContain("<script");
    expect(activeContent(out)).toEqual([]);
    expect(out).not.toMatch(/\bstyle=/);
    expect(out).not.toMatch(/\bon[a-z]+=/i);
    expect(out).not.toMatch(/javascript:/i);
  });

  it("shows the subtotal as a Subtotal term, the order note and the fixed pay note", () => {
    const subtotal = byClass(nodes, "shop-subtotal")[0]!;
    expect(byTag(walk(subtotal), "dt").map(textOf)).toEqual(["Subtotal"]);
    expect(byTag(walk(subtotal), "dd").map(textOf)).toEqual(["$34.00"]);
    expect(textOf(byClass(nodes, "shop-order-note")[0]!)).toBe("Pickup Saturdays.");
    expect(textOf(byClass(nodes, "shop-paynote")[0]!)).toBe("You pay nothing now. Acme Pottery will contact you to confirm your order, payment and how you get it.");
    expect(textOf(byTag(nodes, "h1")[0]!)).toBe("Your cart");
    expect(hasClass(byTag(nodes, "h1")[0]!, "shop-cart__title")).toBe(true);
    expect(textOf(byClass(nodes, "shop-order__title")[0]!)).toBe("Send your order");
  });

  it("omits the order note when none is given (or it is blank)", () => {
    expect(byClass(dom(render()), "shop-order-note")).toHaveLength(0);
    expect(byClass(dom(render({ orderNote: "  \n " })), "shop-order-note")).toHaveLength(0);
  });
});

describe("error summary and field errors", () => {
  const everyError: OrderError[] = [
    { field: "name", code: "name_invalid" },
    { field: "email", code: "email_invalid" },
    { field: "phone", code: "phone_invalid" },
    { field: "fulfilment", code: "fulfilment_invalid" },
    { field: "line1", code: "address_required" },
    { field: "city", code: "required" },
    { field: "state", code: "state_invalid" },
    { field: "zip", code: "zip_invalid" },
    { field: "note", code: "too_long" },
  ];
  const out = render({ errors: everyError, fulfilment: ["pickup", "delivery"] });
  const nodes = dom(out);

  it("links every summary item to an existing id", () => {
    const summary = byClass(nodes, "shop-errors")[0]!;
    expect(attr(summary, "role")).toBe("alert");
    expect(attr(summary, "tabindex")).toBe("-1");
    expect(textOf(byTag(walk(summary), "h2")[0]!)).toBe("There is a problem");
    const links = byTag(walk(summary), "a");
    expect(links.map((a) => attr(a, "href"))).toEqual(["#order-name", "#order-email", "#order-phone", "#order-fulfilment-pickup", "#order-line1", "#order-city", "#order-state", "#order-zip", "#order-note"]);
    for (const link of links) expect(byId(nodes, attr(link, "href")!.slice(1))).toBeDefined();
  });

  it("marks exactly the fields in error with aria-invalid and aria-describedby that point at their error text", () => {
    for (const field of REFILLED_FIELDS) {
      const el = control(nodes, field)!;
      const failing = everyError.some((e) => e.field === field);
      expect(attr(el, "aria-invalid")).toBe(failing ? "true" : undefined);
      if (failing) {
        expect(attr(el, "aria-describedby")).toBe(`order-${field}-error`);
        expect(hasClass(byId(nodes, `order-${field}-error`)!, "shop-field__error")).toBe(true);
      } else expect(attr(el, "aria-describedby")).toBeUndefined();
    }
    expect(attr(byId(nodes, "order-fulfilment"), "aria-describedby")).toBe("order-fulfilment-error");
    expect(byId(nodes, "order-fulfilment-error")).toBeDefined();
  });

  it("writes no error summary and no aria-invalid without errors", () => {
    const clean = dom(render());
    expect(byClass(clean, "shop-errors")).toHaveLength(0);
    expect(clean.some((n) => attr(n, "aria-invalid") !== undefined)).toBe(false);
  });

  it("puts name_invalid on the name field with its exact text", () => {
    const only = dom(render({ errors: [{ field: "name", code: "name_invalid" }] }));
    expect(attr(control(only, "name"), "aria-invalid")).toBe("true");
    expect(squash(textOf(byId(only, "order-name-error")!))).toBe("Error: Enter your name without a web or email address");
  });

  it("writes the phone_invalid text exactly (rev 3b)", () => {
    const only = dom(render({ errors: [{ field: "phone", code: "phone_invalid" }] }));
    expect(textOf(byTag(walk(byClass(only, "shop-errors")[0]!), "a")[0]!)).toBe("Enter a US phone number with area code, like (512) 555-0199");
  });

  it.each<[RefilledField | "fulfilment", OrderErrorCode, string]>([
    ["name", "required", "Enter your name"],
    ["email", "required", "Enter your email address"],
    ["phone", "required", "Enter your phone number"],
    ["line1", "required", "Enter your address line 1"],
    ["line2", "required", "Enter your address line 2"],
    ["city", "required", "Enter your city"],
    ["state", "required", "Enter your state"],
    ["zip", "required", "Enter your ZIP code"],
    ["note", "required", "Enter your note"],
    ["name", "too_long", "Name is too long"],
    ["email", "too_long", "Email address is too long"],
    ["phone", "too_long", "Phone number is too long"],
    ["line1", "too_long", "Address line 1 is too long"],
    ["line2", "too_long", "Address line 2 is too long"],
    ["city", "too_long", "City is too long"],
    ["state", "too_long", "State is too long"],
    ["zip", "too_long", "ZIP code is too long"],
    ["note", "too_long", "Note is too long"],
    ["email", "email_invalid", "Enter an email address like name@example.com"],
    ["state", "state_invalid", "Enter the 2-letter state, like TX"],
    ["zip", "zip_invalid", "Enter a 5-digit ZIP code"],
    ["fulfilment", "fulfilment_invalid", "Choose how you want to get your order"],
    ["line1", "address_required", "Enter your address, or choose pickup"],
  ])("%s / %s reads %j", (field, code, text) => {
    const only = dom(render({ errors: [{ field, code }], fulfilment: ["pickup", "delivery"] }));
    expect(textOf(byTag(walk(byClass(only, "shop-errors")[0]!), "a")[0]!)).toBe(text);
  });
});

describe("refill", () => {
  it("fills every input's value and the note's text", () => {
    const refill = { name: "Ann Lee", email: "ann@example.com", phone: "5125550199", line1: "1 Main St", line2: "Apt 2", city: "Austin", state: "TX", zip: "78701", note: "Leave at door" };
    const nodes = dom(render({ refill, fulfilment: ["delivery"] }));
    for (const field of REFILLED_FIELDS) {
      const el = control(nodes, field)!;
      expect(field === "note" ? textOf(el) : attr(el, "value")).toBe(refill[field]);
    }
  });

  it("checks only the refilled fulfilment radio", () => {
    const nodes = dom(render({ fulfilment: ["pickup", "delivery", "shipping"], refill: { fulfilment: "delivery" } }));
    const radios = byTag(nodes, "input").filter((n) => attr(n, "type") === "radio");
    expect(radios.map((r) => [attr(r, "value"), attr(r, "checked") !== undefined])).toEqual([["pickup", false], ["delivery", true], ["shipping", false]]);
  });

  it("without a refill, every field is empty and no radio is checked (two options)", () => {
    const nodes = dom(render());
    expect(byTag(nodes, "input").filter((n) => attr(n, "type") === "radio").some((r) => attr(r, "checked") !== undefined)).toBe(false);
    expect(attr(control(nodes, "name"), "value")).toBe("");
  });
});

describe("fulfilment and address rules", () => {
  const radiosOf = (nodes: Node[]) => byTag(nodes, "input").filter((n) => attr(n, "type") === "radio");

  it("pickup only: one checked radio, no address fieldset", () => {
    const nodes = dom(render({ fulfilment: ["pickup"] }));
    expect(radiosOf(nodes).map((r) => [attr(r, "value"), attr(r, "checked") !== undefined])).toEqual([["pickup", true]]);
    expect(byClass(nodes, "shop-address")).toHaveLength(0);
    expect(control(nodes, "line1")).toBeUndefined();
  });

  it("one non-pickup option: one checked radio, address required", () => {
    const nodes = dom(render({ fulfilment: ["shipping"] }));
    expect(radiosOf(nodes).map((r) => [attr(r, "value"), attr(r, "checked") !== undefined])).toEqual([["shipping", true]]);
    expect(byClass(nodes, "shop-address")).toHaveLength(1);
  });

  it("pickup plus another option: address fields not required, with the hint", () => {
    const nodes = dom(render({ fulfilment: ["pickup", "shipping"] }));
    for (const field of ["line1", "line2", "city", "state", "zip"]) expect(attr(control(nodes, field), "required")).toBeUndefined();
    const hint = byClass(nodes, "shop-field__hint")[0]!;
    expect(textOf(hint)).toBe("Not needed for pickup.");
    expect(attr(byClass(nodes, "shop-address")[0], "aria-describedby")).toBe(attr(hint, "id"));
  });

  it("no pickup: line1, city, state and zip required, line2 never, no hint", () => {
    const nodes = dom(render({ fulfilment: ["delivery", "shipping"] }));
    for (const field of ["line1", "city", "state", "zip"]) expect(attr(control(nodes, field), "required")).toBeDefined();
    expect(attr(control(nodes, "line2"), "required")).toBeUndefined();
    expect(byClass(nodes, "shop-field__hint")).toHaveLength(0);
  });

  it("name and email are always required, phone and note never", () => {
    const nodes = dom(render());
    expect([attr(control(nodes, "name"), "required"), attr(control(nodes, "email"), "required")].every((v) => v !== undefined)).toBe(true);
    expect([attr(control(nodes, "phone"), "required"), attr(control(nodes, "note"), "required")]).toEqual([undefined, undefined]);
  });

  it("lists the options in FULFILMENT order whatever order they are given, with their labels", () => {
    const nodes = dom(render({ fulfilment: ["shipping", "pickup"] as Fulfilment[] }));
    expect(radiosOf(nodes).map((r) => attr(r, "value"))).toEqual(["pickup", "shipping"]);
    expect(byTag(nodes, "label").filter((l) => (attr(l, "for") ?? "").startsWith("order-fulfilment-")).map(textOf)).toEqual(["Pickup", "Shipping"]);
    expect(textOf(byTag(nodes, "legend")[0]!)).toBe("How do you want to get your order?");
  });

  it("names its radios from fields.ts", () => {
    for (const r of radiosOf(dom(render({ fulfilment: [...FULFILMENT] })))) expect(attr(r, "name")).toBe(ORDER_FIELD.fulfilment);
  });
});

describe("notices, empty cart and line words", () => {
  const ALL: CartNotice[] = ["added", "updated", "removed", "items_removed", "prices_changed"];
  const TEXT: Record<CartNotice, string> = {
    added: "Added to your cart.",
    updated: "Your cart was updated.",
    removed: "Item removed.",
    items_removed: "Some items are no longer available and were removed.",
    prices_changed: "Prices or items changed. Please check your cart.",
  };

  it("shows notices in the spec's order whatever order they come in, warning ones with the warn class", () => {
    const nodes = dom(render({ notices: [...ALL].reverse() }));
    const notices = byClass(nodes, "shop-notice");
    expect(notices.map(textOf)).toEqual(ALL.map((n) => TEXT[n]));
    expect(notices.every((n) => attr(n, "role") === "status")).toBe(true);
    expect(notices.map((n) => hasClass(n, "shop-notice--warn"))).toEqual([false, false, false, true, true]);
  });

  it("shows notices on an empty cart inside .shop-cart-empty, above the empty state, with no order form", () => {
    const out = render({ lines: [], subtotalCents: 0, notices: ["removed"] });
    const nodes = dom(out);
    const empty = byClass(nodes, "shop-cart-empty")[0]!;
    expect(textOf(byClass(walk(empty), "shop-notice")[0]!)).toBe("Item removed.");
    expect(textOf(byTag(walk(empty), "h1")[0]!)).toBe("Your cart is empty");
    const link = byTag(walk(empty), "a")[0]!;
    expect([attr(link, "href"), textOf(link)]).toEqual(["/shop", "See all products"]);
    expect(byTag(nodes, "form")).toHaveLength(0);
    expect(out.indexOf("shop-notice")).toBeLessThan(out.indexOf("<h1"));
  });

  it("writes unit price with each, the was-price, and the hidden word before the line amount", () => {
    const nodes = dom(render({ lines: [line({ compareAtCents: 1500 })] }));
    const unit = byClass(nodes, "shop-line__unit")[0]!;
    expect(squash(textOf(unit))).toBe("$12.50 each Was $15.00");
    const was = byTag(walk(unit), "s")[0]!;
    expect([hasClass(was, "shop-line__was"), textOf(was)]).toEqual([true, "Was $15.00"]);
    const total = byClass(nodes, "shop-line__total")[0]!;
    expect(textOf(total)).toBe("Amount $25.00");
    expect(hasClass(byTag(walk(total), "span")[0]!, "visually-hidden")).toBe(true);
    expect(textOf(byTag(walk(total), "span")[0]!)).toBe("Amount ");
  });

  it.each([undefined, 1250, 900])("shows no was-price when the former price is %s (not above the unit price)", (compareAtCents) => {
    const unit = byClass(dom(render({ lines: [line(compareAtCents === undefined ? {} : { compareAtCents })] })), "shop-line__unit")[0]!;
    expect(squash(textOf(unit))).toBe("$12.50 each");
  });

  it("names the product and variant in the hidden Remove words", () => {
    const buttons = byTag(dom(render({ lines: [variantLine()] })), "button");
    expect(textOf(buttons[1]!)).toBe("Remove Blue mug M / Blue");
    expect(textOf(buttons[0]!)).toBe("Update Blue mug M / Blue");
    const plain = byTag(dom(render()), "button");
    expect(textOf(plain[1]!)).toBe("Remove Blue mug");
    expect(textOf(plain[0]!)).toBe("Update Blue mug");
    const label = byTag(dom(render()), "label").find((l) => attr(l, "for") === "cart-qty-1")!;
    expect(textOf(label)).toBe("Quantity Blue mug");
    expect(attr(byTag(walk(label), "span")[0]!, "class")).toBe("visually-hidden");
  });

  it("formats money exactly, with thousands grouped", () => {
    const out = render({ lines: [line({ unitCents: 129950, qty: 1, lineCents: 129950 })], subtotalCents: 129950 });
    expect(out).toContain("$1,299.50 each");
    expect(textOf(byTag(walk(byClass(dom(out), "shop-subtotal")[0]!), "dd")[0]!)).toBe("$1,299.50");
  });
});

describe("the sent slot", () => {
  it("shows the number, lines, subtotal and fulfilment with an order", () => {
    const out = renderSentSlot(
      sent({
        order: {
          number: 1042,
          lines: [{ name: "Blue mug", variantLabel: "M / Blue", qty: 2, lineCents: 2500 }, { name: "Red bowl", qty: 1, lineCents: 900 }],
          subtotalCents: 3400,
          fulfilment: "shipping",
        },
      }),
    );
    const nodes = dom(out);
    expect(textOf(byTag(nodes, "h1")[0]!)).toBe("Order received");
    expect(squash(textOf(byTag(nodes, "p")[0]!))).toBe("Thank you. Acme Pottery has your order and will contact you.");
    expect(textOf(byClass(nodes, "shop-sent__number")[0]!)).toBe("Order number 1042");
    const items = byClass(nodes, "shop-line");
    expect(items).toHaveLength(2);
    expect(byTag(nodes, "a")).toHaveLength(0);
    expect(textOf(byClass(items[0]!.childNodes ? walk(items[0]!) : [], "shop-line__name")[0]!)).toBe("Blue mug");
    expect(squash(textOf(items[0]!))).toContain("Quantity: 2");
    expect(squash(textOf(items[0]!))).toContain("Amount $25.00");
    expect(squash(textOf(items[1]!))).toContain("Quantity: 1");
    expect(textOf(byTag(walk(byClass(nodes, "shop-subtotal")[0]!), "dd")[0]!)).toBe("$34.00");
    expect(textOf(byClass(nodes, "shop-sent__fulfilment")[0]!)).toBe("You chose shipping.");
    expect(out).not.toMatch(/\btotal\b/i);
    expect(activeContent(out)).toEqual([]);
  });

  it.each(FULFILMENT.map((f) => [f] as const))("says what was chosen: %s", (fulfilment) => {
    const out = renderSentSlot(sent({ order: { number: 1001, lines: [{ name: "x", qty: 1, lineCents: 100 }], subtotalCents: 100, fulfilment } }));
    expect(textOf(byClass(dom(out), "shop-sent__fulfilment")[0]!)).toBe(`You chose ${fulfilment}.`);
  });

  it("without an order is the generic received page: heading and thank-you only", () => {
    const out = renderSentSlot({ businessName: "Acme Pottery" });
    const nodes = dom(out);
    expect(textOf(byTag(nodes, "h1")[0]!)).toBe("Order received");
    expect(squash(textOf(byTag(nodes, "p")[0]!))).toBe("Thank you. Acme Pottery has your order and will contact you.");
    expect(byClass(nodes, "shop-sent__number")).toHaveLength(0);
    expect(byClass(nodes, "shop-line")).toHaveLength(0);
    expect(byClass(nodes, "shop-subtotal")).toHaveLength(0);
    expect(byClass(nodes, "shop-sent__fulfilment")).toHaveLength(0);
  });

  it("never writes a buyer's name, email, phone or address, even if handed one", () => {
    const order = { ...sent().order!, name: "Ann Buyer", email: "ann@buyer.test", phone: "5125550123", line1: "9 Secret Rd" } as never;
    const out = renderSentSlot({ businessName: "Acme Pottery", order });
    for (const secret of ["Ann Buyer", "ann@buyer.test", "5125550123", "9 Secret Rd"]) expect(out).not.toContain(secret);
  });
});

describe("the refusal slot", () => {
  const SENTENCE: Record<RefusalReason, string> = {
    rate_limited: "Too many tries. Please wait a minute and try again.",
    orders_paused: "This shop is not taking orders online right now.",
    daily_cap: "This shop is not taking more online orders today.",
    order_too_large: "This order is too large to send online.",
    cart_too_large: "Your cart has too many items.",
    not_available: "Online orders are not available right now.",
  };
  it.each(Object.entries(SENTENCE) as [RefusalReason, string][])("%s: heading, one sentence, and the phone", (reason, sentence) => {
    const out = renderRefusalSlot({ reason, businessName: "Acme Pottery", phone: PHONE });
    const nodes = dom(out);
    expect(hasClass(nodes.find((n) => n.tagName === "div")!, "shop-refusal")).toBe(true);
    expect(textOf(byTag(nodes, "h1")[0]!)).toBe("Sorry, that did not go through");
    const paragraphs = byTag(nodes, "p");
    expect(textOf(paragraphs[0]!)).toBe(sentence);
    expect(textOf(paragraphs[1]!)).toBe("Please call (512) 555-0199.");
    const tel = byTag(nodes, "a")[0]!;
    expect([attr(tel, "href"), textOf(tel)]).toEqual([`tel:${PHONE}`, "(512) 555-0199"]);
    expect(activeContent(out)).toEqual([]);
  });

  it("omits the call line without a phone", () => {
    const out = renderRefusalSlot({ reason: "orders_paused", businessName: "Acme Pottery" });
    expect(out).not.toContain("Please call");
    expect(byTag(dom(out), "a")).toHaveLength(0);
  });
});

// ---- Titles ----------------------------------------------------------------------------------------------------------

describe("titles", () => {
  it("writes the fixed titles", () => {
    expect(cartPageTitle("Acme Pottery", { hasErrors: false })).toBe("Your cart | Acme Pottery");
    expect(cartPageTitle("Acme Pottery", { hasErrors: true })).toBe("Error: Your cart | Acme Pottery");
    expect(sentPageTitle("Acme Pottery")).toBe("Order received | Acme Pottery");
    expect(refusalPageTitle("Acme Pottery")).toBe("Order not sent | Acme Pottery");
  });

  it("clips a long name with clipText so the escaped title is never over 70 characters, and keeps its fixed words", () => {
    const names = ["Acme ".repeat(60), "&".repeat(100), "Å".repeat(200), "Bakery & Sons Plumbing, Heating and Air Conditioning of Greater Austin Texas"];
    for (const name of names) {
      for (const title of [cartPageTitle(name, { hasErrors: false }), cartPageTitle(name, { hasErrors: true }), sentPageTitle(name), refusalPageTitle(name)]) {
        expect(escapeText(title).length).toBeLessThanOrEqual(70);
        expect(title).toMatch(/^(Error: )?(Your cart|Order received|Order not sent) | /);
        expect(title.endsWith("…")).toBe(true);
      }
    }
    expect(cartPageTitle("Short", { hasErrors: false })).not.toContain("…");
  });

  it("does not clip a name that fits", () => {
    const name = "N".repeat(70 - "Your cart | ".length);
    expect(cartPageTitle(name, { hasErrors: false })).toBe(`Your cart | ${name}`);
  });

  it.each(["", "   ", "\n\t "])("drops the separator and the name when the business name is blank (%j)", (blank) => {
    expect(cartPageTitle(blank, { hasErrors: false })).toBe("Your cart");
    expect(cartPageTitle(blank, { hasErrors: true })).toBe("Error: Your cart");
    expect(sentPageTitle(blank)).toBe("Order received");
    expect(refusalPageTitle(blank)).toBe("Order not sent");
  });

  it("throws on a business name that is not text", () => {
    for (const bad of [undefined, null, 5, {}]) {
      expect(() => cartPageTitle(bad as never, { hasErrors: false })).toThrow();
      expect(() => sentPageTitle(bad as never)).toThrow();
      expect(() => refusalPageTitle(bad as never)).toThrow();
    }
  });
});

// ---- A blank business name (the pages lane sends "" when the pointer lacks one, and on an R2 failure) -------------------

describe("a blank business name", () => {
  it.each(["", "  ", "\n"])("reads %j as 'The shop' in every sentence and never writes a broken one", (blank) => {
    const cartOut = render({ businessName: blank });
    expect(textOf(byClass(dom(cartOut), "shop-paynote")[0]!)).toBe("You pay nothing now. The shop will contact you to confirm your order, payment and how you get it.");
    const sentOut = renderSentSlot(sent({ businessName: blank }));
    expect(squash(textOf(byTag(dom(sentOut), "p")[0]!))).toBe("Thank you. The shop has your order and will contact you.");
    const refusal = renderRefusalSlot({ reason: "rate_limited", businessName: blank });
    expect(refusal).toContain("Too many tries.");
    for (const out of [cartOut, sentOut, refusal]) {
      expect(out).not.toMatch(/\.\s{2,}\w/);
      expect(squash(textOf(dom(out)[0]!))).not.toMatch(/\.\s+(will|has) /);
    }
  });

  it("renders (does not throw): an order already stored must still get its page", () => {
    expect(() => renderSentSlot({ businessName: "" })).not.toThrow();
    expect(() => renderSentSlot(sent({ businessName: "" }))).not.toThrow();
    expect(() => render({ businessName: "" })).not.toThrow();
    expect(() => renderRefusalSlot({ reason: "rate_limited", businessName: "" })).not.toThrow();
  });

  it("throws only when the business name is not text at all", () => {
    expect(() => renderCartSlot({ ...cart(), businessName: undefined } as never)).toThrow();
    expect(() => renderSentSlot({ businessName: 5 } as never)).toThrow();
    expect(() => renderRefusalSlot({ reason: "rate_limited", businessName: null } as never)).toThrow();
  });
});

// ---- Guards ----------------------------------------------------------------------------------------------------------

describe("guards: a wrong input is the caller's bug and throws, never a wrong page", () => {
  const BAD_ID = "11111111-1111-1111-1111-111111111111"; // not a v4 uuid
  const many = (n: number): CartLineInput[] =>
    Array.from({ length: n }, (_, i) => line({ productId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`, slug: `p-${i}`, unitCents: 100, qty: 1, lineCents: 100 }));

  it.each<[string, () => string]>([
    ["lineCents is not unitCents * qty", () => render({ lines: [line({ lineCents: 2501 })] })],
    ["lineCents is not a number", () => render({ lines: [line({ lineCents: "2500" as never })] })],
    ["subtotal is not the sum", () => render({ subtotalCents: 2501 })],
    ["subtotal of an empty cart is not 0", () => render({ lines: [], subtotalCents: 1 })],
    ["invalid siteId", () => render({ siteId: BAD_ID })],
    ["siteId with a path in it", () => render({ siteId: `${SITE}/../x` })],
    ["invalid productId", () => render({ lines: [line({ productId: BAD_ID })] })],
    ["invalid variantId", () => render({ lines: [variantLine({ variantId: BAD_ID })] })],
    ["slug with an uppercase letter", () => render({ lines: [line({ slug: "Blue-Mug" })] })],
    ["slug with a slash", () => render({ lines: [line({ slug: "a/b" })] })],
    ["empty slug", () => render({ lines: [line({ slug: "" })] })],
    ["a quote that is too short", () => render({ quote: "short" })],
    ["a quote with a bad character", () => render({ quote: `${"a".repeat(20)}=` })],
    ["a quote that is too long", () => render({ quote: "a".repeat(129) })],
    ["a missing quote", () => render({ quote: undefined as never })],
    ["21 lines", () => render({ lines: many(21), subtotalCents: 2100 })],
    ["variantId without variantLabel", () => render({ lines: [line({ variantId: VAR })] })],
    ["variantLabel without variantId", () => render({ lines: [line({ variantLabel: "M" })] })],
    ["empty fulfilment", () => render({ fulfilment: [] })],
    ["an unknown fulfilment option", () => render({ fulfilment: ["courier" as never] })],
    ["a repeated fulfilment option", () => render({ fulfilment: ["pickup", "pickup"] })],
    ["qty 0", () => render({ lines: [line({ qty: 0, lineCents: 0 })] })],
    ["qty above maxQty", () => render({ lines: [line({ qty: 11, lineCents: 13750 })], subtotalCents: 13750 })],
    ["a fractional qty", () => render({ lines: [line({ qty: 1.5, lineCents: 1875 })], subtotalCents: 1875 })],
    ["maxQty 100", () => render({ lines: [line({ maxQty: 100 })] })],
    ["a fractional price", () => render({ lines: [line({ unitCents: 12.5, lineCents: 25 })], subtotalCents: 25 })],
    ["a NaN price", () => render({ lines: [line({ unitCents: Number.NaN })] })],
    ["a zero price", () => render({ lines: [line({ unitCents: 0, lineCents: 0 })], subtotalCents: 0 })],
    ["an unsafe price", () => render({ lines: [line({ unitCents: 2 ** 53, lineCents: 2 ** 53 })], subtotalCents: 2 ** 53 })],
    ["a former price that is not whole cents", () => render({ lines: [line({ compareAtCents: 15.5 })] })],
    ["an unknown notice", () => render({ notices: ["nope" as never] })],
    ["a duplicate notice", () => render({ notices: ["added", "added"] })],
    ["two errors for one field", () => render({ errors: [{ field: "name", code: "required" }, { field: "name", code: "too_long" }] })],
    ["an error on an unknown field", () => render({ errors: [{ field: "website" as never, code: "required" }] })],
    ["a code that does not fit its field", () => render({ errors: [{ field: "email", code: "zip_invalid" }] })],
    ["fulfilment_invalid on another field", () => render({ errors: [{ field: "name", code: "fulfilment_invalid" }] })],
    ["required on fulfilment", () => render({ errors: [{ field: "fulfilment", code: "required" }] })],
    ["an error on an address field a pickup-only form does not show", () => render({ fulfilment: ["pickup"], errors: [{ field: "city", code: "required" }] })],
    ["a refill that is not text", () => render({ refill: { name: 5 } as never })],
    ["an order note that is not text", () => render({ orderNote: 5 as never })],
    ["a product name that is not text", () => render({ lines: [line({ name: undefined as never })] })],
  ])("the cart throws on %s", (_name, run) => {
    expect(run).toThrow();
  });

  it("validates an empty cart's site id and notices too", () => {
    expect(() => render({ lines: [], subtotalCents: 0, siteId: BAD_ID })).toThrow();
    expect(() => render({ lines: [], subtotalCents: 0, notices: ["added", "added"] })).toThrow();
  });

  it("accepts the limits: 20 lines, qty = maxQty = 99, a 128-character quote", () => {
    expect(() => render({ lines: many(20), subtotalCents: 2000 })).not.toThrow();
    expect(() => render({ lines: [line({ qty: 99, maxQty: 99, unitCents: 100, lineCents: 9900 })], subtotalCents: 9900 })).not.toThrow();
    expect(() => render({ quote: "a".repeat(128) })).not.toThrow();
    expect(() => render({ quote: "a".repeat(16) })).not.toThrow();
  });

  const order = () => sent().order!;
  it.each<[string, () => string]>([
    ["an order number below 1001", () => renderSentSlot(sent({ order: { ...order(), number: 1000 } }))],
    ["a fractional order number", () => renderSentSlot(sent({ order: { ...order(), number: 1001.5 } }))],
    ["no lines", () => renderSentSlot(sent({ order: { ...order(), lines: [], subtotalCents: 0 } }))],
    ["21 lines", () => renderSentSlot(sent({ order: { ...order(), lines: Array.from({ length: 21 }, () => ({ name: "x", qty: 1, lineCents: 100 })), subtotalCents: 2100 } }))],
    ["a subtotal that is not the sum", () => renderSentSlot(sent({ order: { ...order(), subtotalCents: 2501 } }))],
    ["a zero qty", () => renderSentSlot(sent({ order: { ...order(), lines: [{ name: "x", qty: 0, lineCents: 100 }], subtotalCents: 100 } }))],
    ["a fractional line amount", () => renderSentSlot(sent({ order: { ...order(), lines: [{ name: "x", qty: 1, lineCents: 0.5 }], subtotalCents: 0.5 } }))],
    ["an unknown fulfilment", () => renderSentSlot(sent({ order: { ...order(), fulfilment: "courier" as never } }))],
    ["variantLabel that is not text", () => renderSentSlot(sent({ order: { ...order(), lines: [{ name: "x", variantLabel: 5 as never, qty: 1, lineCents: 2500 }] } }))],
  ])("the sent page throws on %s", (_name, run) => {
    expect(run).toThrow();
  });

  it.each(["5125550199", "+1512555019", "+15125550199 ", "+11125550199", "+15121550199", "+442071838750", "(512) 555-0199", '"><script>', ""])(
    "the refusal throws on the phone %j",
    (phone) => {
      expect(() => renderRefusalSlot({ reason: "rate_limited", businessName: "Acme", phone })).toThrow();
    },
  );

  it("the refusal throws on an unknown reason", () => {
    expect(() => renderRefusalSlot({ reason: "teapot" as never, businessName: "Acme" })).toThrow();
  });
});

// ---- Determinism -----------------------------------------------------------------------------------------------------

describe("determinism", () => {
  it("gives byte-identical output for the same input, whatever was rendered between", () => {
    const input = cart({
      lines: [variantLine({ compareAtCents: 1500 })],
      notices: ["prices_changed", "added"],
      orderNote: "a\nb",
      errors: [{ field: "email", code: "email_invalid" }],
      refill: { email: "x\"y", note: "n", fulfilment: "delivery" },
    });
    const first = renderCartSlot(input);
    renderSentSlot(sent());
    renderRefusalSlot({ reason: "daily_cap", businessName: "Z", phone: PHONE });
    expect(renderCartSlot(input)).toBe(first);
    expect(renderSentSlot(sent())).toBe(renderSentSlot(sent()));
    expect(renderRefusalSlot({ reason: "daily_cap", businessName: "Z" })).toBe(renderRefusalSlot({ reason: "daily_cap", businessName: "Z" }));
  });
});
