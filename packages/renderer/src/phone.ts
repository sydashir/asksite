// The phone helpers, in a module of their own so the cart markup (shop/cart-markup.ts, the sites Worker's cart path)
// can use them without format.ts's other code. format.ts re-exports both, so every other caller is unchanged.
import { safeUrl, type SafeUrl } from "./html.ts";

/** "+15125550142" -> "(512) 555-0142". Input is already validated as US E.164. */
export function formatPhone(e164: string): string {
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** RFC 3966 global number: tel:+15125550142. */
export function telUrl(e164: string): SafeUrl {
  return safeUrl(`tel:${e164}`, ["tel:"]);
}
