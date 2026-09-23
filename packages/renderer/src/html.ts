import { isSafeUrl, type UrlScheme } from "@asksite/site-schema";
import { escapeAttr, escapeText } from "./escape.ts";

/**
 * Markup that is already safe. `html` templates and `trusted()` make it; our own code may also wrap
 * a whole element it has made safe itself (the JSON-LD <script>, a <style> sheet) with `new SafeHtml`.
 * Never wrap user data in it.
 */
export class SafeHtml {
  readonly #markup: string;
  constructor(markup: string) {
    this.#markup = markup;
  }
  toString(): string {
    return this.#markup;
  }
}

// Output of trusted(): the only markup allowed between attributes. Not exported, so an html``
// fragment (whose values were escaped as text, not checked as attributes) can never pass for it.
class TrustedHtml extends SafeHtml {}

/**
 * A URL whose scheme has been checked. The only value `html` accepts in a URL attribute (href, src,
 * action, …). Exported as a type only, so safeUrl() and fragment() are the only ways to make one.
 */
class SafeUrl {
  readonly #href: string;
  constructor(href: string) {
    this.#href = href;
  }
  toString(): string {
    return this.#href;
  }
}
export type { SafeUrl };

export type Value = string | number | SafeHtml | SafeUrl | false | null | undefined | readonly Value[];

/** Wrap a string literal from our own source (icons, boolean attributes). Never pass user data. */
export function trusted(markup: string): SafeHtml {
  return new TrustedHtml(markup);
}

/** Validate an absolute URL; throws on anything else, so an unsafe URL can never be rendered. */
export function safeUrl(input: string, allowed?: readonly UrlScheme[]): SafeUrl {
  if (!isSafeUrl(input, allowed)) throw new Error(`Unsafe URL rejected: ${JSON.stringify(input)}`);
  return new SafeUrl(input);
}

/** In-page link to one of our own element ids, e.g. "#services". */
export function fragment(id: string): SafeUrl {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid fragment id: ${JSON.stringify(id)}`);
  return new SafeUrl(`#${id}`);
}

// "script" and "style" mean inside that element's content, which the browser runs as JavaScript or
// CSS: escaping cannot make a value safe there.
type State = "text" | "tag" | "comment" | "script" | "style";
type Context = {
  state: State;
  tag: string; // lower-cased name of the tag being written ("" for an end tag or <!doctype>)
  quote: "" | '"' | "'"; // the quote that opened the attribute value we are in, "" outside one
  attr: string; // lower-cased name of that attribute, "" when the literal does not show it
};

const INSIDE: Record<Exclude<State, "text">, string> = {
  tag: "a tag",
  comment: "a comment",
  script: "a <script> element",
  style: "a <style> element",
};

// The attribute name just before `="` or `='`, allowing spaces around "=" as HTML does.
const ATTRIBUTE_NAME = /([^\s"'<>\/=]+)\s*=\s*$/;
const TAG_NAME = /^[a-z][^\s/>]*/i;
const END_TAG = { script: /^<\/script[\s/>]/i, style: /^<\/style[\s/>]/i };

// Tracks where the end of the markup written so far is: in text, inside a tag (and inside a quoted
// attribute value, where ">" does not end the tag), inside a comment, or inside a <script> or <style>.
function advance(context: Context, literal: string): Context {
  let { state, tag, quote, attr } = context;
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i];
    if (state === "text") {
      if (literal.startsWith("<!--", i)) {
        state = "comment";
        i += 3;
      } else if (c === "<") {
        state = "tag";
        tag = TAG_NAME.exec(literal.slice(i + 1))?.[0].toLowerCase() ?? "";
      }
    } else if (state === "comment") {
      if (literal.startsWith("-->", i)) {
        state = "text";
        i += 2;
      }
    } else if (state === "script" || state === "style") {
      if (c === "<" && END_TAG[state].test(literal.slice(i))) {
        state = "tag";
        tag = "";
      }
    } else if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
      attr = ATTRIBUTE_NAME.exec(literal.slice(0, i))?.[1]?.toLowerCase() ?? "";
    } else if (c === ">") {
      state = tag === "script" || tag === "style" ? tag : "text";
    }
  }
  return { state, tag, quote, attr };
}

// Attributes a browser fetches or navigates to: only a SafeUrl may be interpolated.
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "data", "ping", "background", "xlink:href"]);

// Attributes that run script, carry CSS, hold several URLs or hold a whole HTML document:
// no interpolation at all (a future srcset needs its own SafeSrcset type first).
const isNeverInterpolated = (attr: string) =>
  attr.startsWith("on") || attr === "style" || attr === "srcset" || attr === "imagesrcset" || attr === "srcdoc";

function interpolate(value: Value, context: Context): string {
  const { state, quote, attr } = context;
  if (state !== "text" && state !== "tag") throw new Error(`Nothing may be interpolated inside ${INSIDE[state]}`);
  if (quote && attr === "") throw new Error("Cannot tell which attribute this value is in");
  if (quote && isNeverInterpolated(attr)) throw new Error(`The ${attr} attribute never takes an interpolated value`);
  if (value === false || value === null || value === undefined) {
    if (quote && URL_ATTRIBUTES.has(attr)) throw new Error(`Missing URL for ${attr}`);
    return "";
  }
  if (state === "text") {
    if (value instanceof SafeHtml) return value.toString();
    if (Array.isArray(value)) return value.map((v: Value) => interpolate(v, context)).join("");
    return escapeText(String(value));
  }
  if (quote !== '"') {
    // Between attributes only trusted() literals (e.g. a boolean attribute) are allowed.
    if (!quote && value instanceof TrustedHtml) return value.toString();
    throw new Error("Interpolation inside a tag must be a double-quoted attribute value or trusted() markup");
  }
  if (URL_ATTRIBUTES.has(attr)) {
    if (!(value instanceof SafeUrl)) throw new Error(`The ${attr} attribute needs a SafeUrl`);
    return escapeAttr(value.toString());
  }
  if (value instanceof SafeHtml || Array.isArray(value)) throw new Error(`Markup is not allowed in the ${attr} attribute`);
  return escapeAttr(String(value));
}

/**
 * Tagged template that escapes every interpolation for where it lands:
 * text nodes -> escapeText, double-quoted attributes -> escapeAttr, URL attributes -> SafeUrl only,
 * between attributes -> trusted() only, event-handler/style/srcset/srcdoc attributes, comments and
 * <script>/<style> content -> never. A template must end in text, so a fragment cannot leave the
 * template it is spliced into tracking the wrong context.
 */
export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let context = advance({ state: "text", tag: "", quote: "", attr: "" }, strings[0] ?? "");
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += interpolate(value, context);
    const literal = strings[i + 1] ?? "";
    context = advance(context, literal);
    out += literal;
  });
  if (context.state !== "text") throw new Error(`An html template must not end inside ${INSIDE[context.state]}`);
  return new SafeHtml(out);
}
