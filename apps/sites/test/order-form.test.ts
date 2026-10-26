import { describe, expect, it } from "vitest";
import { readOrderForm } from "../src/order-form.ts";

// The order form (pages lane proposal 1.6 step 6; cart-markup.md rev 2 §1, §3): the fields name, email, phone (optional),
// fulfilment, line1, line2, city, state, zip, note. Every value is cleaned as the contact form's are (lead.ts); a problem
// becomes one OrderError per field, with cart-markup's codes; the buyer's typed values come back for the refill, never
// the honeypot or the quote.

const GOOD = { name: "Dana Price", email: "dana@example.com", phone: "(512) 555-0199", fulfilment: "pickup", line1: "", line2: "", city: "", state: "", zip: "", note: "" };
const read = (over: Record<string, string> = {}, offered: ("pickup" | "delivery" | "shipping")[] = ["pickup", "delivery", "shipping"]) =>
  readOrderForm(new URLSearchParams({ ...GOOD, website: "", quote: "q".repeat(64), ...over }), offered);

describe("readOrderForm: a valid order", () => {
  it("reads a pickup order: no address, phone and note kept as typed (cleaned)", () => {
    expect(read({ note: "  Ring twice\r\nplease  " })).toEqual({
      ok: true,
      buyer: { name: "Dana Price", email: "dana@example.com", phone: "+15125550199", fulfilment: "pickup", address: null, note: "Ring twice\nplease" },
      refill: { name: "Dana Price", email: "dana@example.com", phone: "+15125550199", line1: "", line2: "", city: "", state: "", zip: "", note: "Ring twice\nplease", fulfilment: "pickup" },
    });
  });

  it("reads a delivery order with its address, upper-casing the state and dropping an empty line2", () => {
    const result = read({ fulfilment: "delivery", line1: "1 Main St", city: "Austin", state: "tx", zip: "78701" });
    expect(result.ok && result.buyer.address).toEqual({ line1: "1 Main St", city: "Austin", state: "TX", zip: "78701" });
  });

  it("takes no phone as null, and normalises a US number to +1 form (cart-markup rev 3), typographic dashes and a leading 1 included", () => {
    expect(read({ phone: "" }).ok && (read({ phone: "" }) as { buyer: { phone: unknown } }).buyer.phone).toBeNull();
    for (const typed of ["512‑555‑0199", "1 512 555 0199", "+1 (512) 555-0199", "512.555.0199"]) {
      const result = read({ phone: typed });
      expect(result.ok && result.buyer.phone, typed).toBe("+15125550199");
    }
  });

  it("ignores address fields on a pickup order (not stored), but refills what was typed", () => {
    const result = read({ line1: "1 Main St" });
    expect(result.ok && result.buyer.address).toBeNull();
    expect(result.refill.line1).toBe("1 Main St");
  });
});

describe("readOrderForm: problems, one per field, with cart-markup's codes", () => {
  const errors = (over: Record<string, string>, offered?: ("pickup" | "delivery" | "shipping")[]) => {
    const result = read(over, offered);
    return result.ok ? [] : result.errors;
  };

  it("name: required, too_long past 80, name_invalid for a link, an email or nothing readable", () => {
    expect(errors({ name: "   " })).toEqual([{ field: "name", code: "required" }]);
    expect(errors({ name: "a".repeat(81) })).toEqual([{ field: "name", code: "too_long" }]);
    expect(errors({ name: "dana@shop.com" })).toEqual([{ field: "name", code: "name_invalid" }]);
    expect(errors({ name: "www.spam.example" })).toEqual([{ field: "name", code: "name_invalid" }]);
    expect(errors({ name: "ㅤㅤ" })).toEqual([{ field: "name", code: "name_invalid" }]);
  });

  it("email: required, too_long past 254, email_invalid", () => {
    expect(errors({ email: "" })).toEqual([{ field: "email", code: "required" }]);
    expect(errors({ email: `${"a".repeat(250)}@x.co` })).toEqual([{ field: "email", code: "too_long" }]);
    expect(errors({ email: "dana@" })).toEqual([{ field: "email", code: "email_invalid" }]);
  });

  it("phone (optional): phone_invalid unless a whole US number (area code included), too_long past 30", () => {
    expect(errors({ phone: "555-01" })).toEqual([{ field: "phone", code: "phone_invalid" }]);
    expect(errors({ phone: "555-0199" })).toEqual([{ field: "phone", code: "phone_invalid" }]);
    expect(errors({ phone: "call me" })).toEqual([{ field: "phone", code: "phone_invalid" }]);
    expect(errors({ phone: "+44 20 7946 0958" })).toEqual([{ field: "phone", code: "phone_invalid" }]);
    expect(errors({ phone: "(012) 555-0199" })).toEqual([{ field: "phone", code: "phone_invalid" }]);
    expect(errors({ phone: "5".repeat(31) })).toEqual([{ field: "phone", code: "too_long" }]);
  });

  it("fulfilment: fulfilment_invalid when missing, unknown, or not one the shop offers", () => {
    expect(errors({ fulfilment: "" })).toEqual([{ field: "fulfilment", code: "fulfilment_invalid" }]);
    expect(errors({ fulfilment: "drone" })).toEqual([{ field: "fulfilment", code: "fulfilment_invalid" }]);
    expect(errors({ fulfilment: "shipping" }, ["pickup"])).toEqual([{ field: "fulfilment", code: "fulfilment_invalid" }]);
  });

  it("address for delivery or shipping: address_required on line1, required on city, state and zip, then their formats", () => {
    expect(errors({ fulfilment: "shipping" })).toEqual([
      { field: "line1", code: "address_required" },
      { field: "city", code: "required" },
      { field: "state", code: "required" },
      { field: "zip", code: "required" },
    ]);
    expect(errors({ fulfilment: "delivery", line1: "1 Main St", city: "Austin", state: "Texas", zip: "787" })).toEqual([
      { field: "state", code: "state_invalid" },
      { field: "zip", code: "zip_invalid" },
    ]);
    expect(errors({ fulfilment: "delivery", line1: "a".repeat(81), line2: "b".repeat(81), city: "c".repeat(41), state: "TX", zip: "78701" })).toEqual([
      { field: "line1", code: "too_long" },
      { field: "line2", code: "too_long" },
      { field: "city", code: "too_long" },
    ]);
  });

  it("note: too_long past 1,000 characters", () => {
    expect(errors({ note: "n".repeat(1001) })).toEqual([{ field: "note", code: "too_long" }]);
  });

  it("reports every field's problem at once, in the form's order", () => {
    expect(errors({ name: "", email: "x", fulfilment: "" }).map((e) => e.field)).toEqual(["name", "email", "fulfilment"]);
  });
});

describe("readOrderForm: the refill", () => {
  it("returns the buyer's cleaned values for every typed field, and the fulfilment only when it is one the shop offers", () => {
    const result = read({ name: "  Dana‮ Price ", fulfilment: "drone", email: "x" });
    expect(result.ok).toBe(false);
    expect(result.refill).toEqual({ name: "Dana Price", email: "x", phone: "+15125550199", line1: "", line2: "", city: "", state: "", zip: "", note: "" });
  });

  it("leaves out a phone that is not a whole US number (cart-markup rev 3 takes only the +1 form)", () => {
    const result = read({ phone: "call me" });
    expect(Object.keys(result.refill)).not.toContain("phone");
  });

  it("never includes the honeypot or the quote", () => {
    const result = read({ website: "bot", quote: "z".repeat(64) });
    expect(Object.keys(result.refill)).not.toContain("website");
    expect(Object.keys(result.refill)).not.toContain("quote");
  });
});
