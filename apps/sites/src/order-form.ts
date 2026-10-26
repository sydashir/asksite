import { clean, isEmail, isReadableName, plainPhone } from "./lead.ts";
import type { Address, Buyer } from "./order-sql.ts";
import { FULFILMENT, type Fulfilment, type OrderError, type OrderRefill, type RefilledField } from "./shop-markup-types.ts";

// The order form's fields (pages lane proposal 1.6 step 6; cart-markup.md rev 3 §1, §3). Every value is cleaned as the
// contact form's are (lead.ts clean: hidden characters out, one-line fields on one line, trimmed). A problem becomes one
// OrderError per field with cart-markup's codes, in the form's order. The buyer's cleaned values come back for the refill
// (never the honeypot or the quote); the phone only in the +1 form cart-markup takes, or not at all.

/** maxlength of each typed field: the same numbers as cart-markup's ORDER_MAX_LENGTH (renderer shop/fields.ts). */
export const ORDER_MAX_LENGTH: Readonly<Record<RefilledField, number>> = { name: 80, email: 254, phone: 30, line1: 80, line2: 80, city: 40, state: 2, zip: 5, note: 1000 };

/** The schema's UsPhone (site-schema facts.ts): +1, then a NANP area code and number. */
const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const PHONE_CHARS = /^[0-9+().\- ]+$/;

/** A typed US number in +1 form, or null: phone characters only, 10 digits or 11 starting with 1 (typographic dashes and spaces allowed). */
export function usPhone(typed: string): string | null {
  const plain = plainPhone(typed);
  if (!PHONE_CHARS.test(plain)) return null;
  const digits = plain.replace(/\D/g, "");
  const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : null;
  return e164 !== null && US_PHONE.test(e164) ? e164 : null;
}

export type OrderFormResult =
  | { ok: true; buyer: Buyer; refill: OrderRefill }
  | { ok: false; errors: OrderError[]; refill: OrderRefill };

/** Reads the posted form for a shop offering `offered` (the catalog's fulfilment). */
export function readOrderForm(fields: URLSearchParams, offered: readonly Fulfilment[]): OrderFormResult {
  const text = (name: RefilledField) => clean(fields.get(name), name === "note");
  const typed = Object.fromEntries((["name", "email", "phone", "line1", "line2", "city", "state", "zip", "note"] as const).map((f) => [f, text(f)])) as Record<RefilledField, string>;
  const fulfilmentValue = fields.get("fulfilment") ?? "";
  const fulfilment = (FULFILMENT as readonly string[]).includes(fulfilmentValue) && offered.includes(fulfilmentValue as Fulfilment) ? (fulfilmentValue as Fulfilment) : null;
  const phone = typed.phone === "" ? null : usPhone(typed.phone);
  const state = typed.state.toUpperCase();

  const errors: OrderError[] = [];
  const problem = (field: OrderError["field"], code: OrderError["code"]) => errors.push({ field, code });
  const tooLong = (field: RefilledField) => typed[field].length > ORDER_MAX_LENGTH[field];

  if (typed.name === "") problem("name", "required");
  else if (tooLong("name")) problem("name", "too_long");
  else if (!isReadableName(typed.name)) problem("name", "name_invalid");

  if (typed.email === "") problem("email", "required");
  else if (tooLong("email")) problem("email", "too_long");
  else if (!isEmail(typed.email)) problem("email", "email_invalid");

  if (typed.phone !== "" && tooLong("phone")) problem("phone", "too_long");
  else if (typed.phone !== "" && phone === null) problem("phone", "phone_invalid");

  if (fulfilment === null) problem("fulfilment", "fulfilment_invalid");

  // An address is asked for delivery and shipping only; for pickup the typed lines are refilled but never stored.
  const needsAddress = fulfilment === "delivery" || fulfilment === "shipping";
  if (needsAddress) {
    if (typed.line1 === "") problem("line1", "address_required");
    else if (tooLong("line1")) problem("line1", "too_long");
    if (tooLong("line2")) problem("line2", "too_long");
    if (typed.city === "") problem("city", "required");
    else if (tooLong("city")) problem("city", "too_long");
    if (state === "") problem("state", "required");
    else if (!/^[A-Z]{2}$/.test(state)) problem("state", "state_invalid");
    if (typed.zip === "") problem("zip", "required");
    else if (!/^\d{5}$/.test(typed.zip)) problem("zip", "zip_invalid");
  }

  if (tooLong("note")) problem("note", "too_long");

  const { phone: _typedPhone, ...rest } = typed;
  const refill: OrderRefill = { ...rest, ...(phone === null ? {} : { phone }), ...(fulfilment === null ? {} : { fulfilment }) };
  if (errors.length > 0 || fulfilment === null) return { ok: false, errors, refill };

  const address: Address | null = needsAddress
    ? { line1: typed.line1, ...(typed.line2 === "" ? {} : { line2: typed.line2 }), city: typed.city, state, zip: typed.zip }
    : null;
  return { ok: true, buyer: { name: typed.name, email: typed.email, phone, fulfilment, address, note: typed.note === "" ? null : typed.note }, refill };
}
