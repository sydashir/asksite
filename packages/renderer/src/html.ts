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

// Output of trusted(): markup from our own source, which html reads like its own literal text. The
// only markup allowed between attributes. Not exported, so an html`` fragment (whose values were
// escaped as text, not checked as attributes) can never pass for it.
class TrustedHtml extends SafeHtml {}

// Only safeUrl() and fragment() hold this key, so no code outside this module can make a SafeUrl,
// not even through safeUrl(x).constructor.
const MINT = Symbol("SafeUrl");

// The href of a real SafeUrl; undefined for anything else, even an object given SafeUrl's prototype.
// Set inside the class, the only place that can read #href, but kept off it: a static method could
// be replaced through safeUrl(x).constructor, switching the check off for every later template.
let hrefOf: (value: unknown) => string | undefined;

/**
 * A URL whose scheme has been checked. The only value `html` accepts in a URL attribute (href, src,
 * action, …). Exported as a type only, so safeUrl() and fragment() are the only ways to make one.
 */
class SafeUrl {
  readonly #href: string;
  constructor(key: symbol, href: string) {
    if (key !== MINT) throw new Error("Only safeUrl() and fragment() can make a SafeUrl");
    this.#href = href;
  }
  toString(): string {
    return this.#href;
  }
  static {
    hrefOf = (value) => (typeof value === "object" && value !== null && #href in value ? value.#href : undefined);
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
  return new SafeUrl(MINT, input);
}

/** In-page link to one of our own element ids, e.g. "#services". */
export function fragment(id: string): SafeUrl {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid fragment id: ${JSON.stringify(id)}`);
  return new SafeUrl(MINT, `#${id}`);
}

// The states of the WHATWG HTML tokenizer (https://html.spec.whatwg.org/multipage/parsing.html#tokenization)
// that decide where a value lands. States that never change that are folded into a neighbour:
// markup declaration open and raw text's end-tag states (look-aheads in advance(), which throw when
// the markup ends before they can decide), character references, the comment less-than-sign
// states, and the DOCTYPE sub-states (every one ends at ">").
// "rcdata" is the text of <title> and <textarea>; "rawtext" the text of <style>, <script>, <xmp>,
// <iframe>, <noembed>, <noframes> and <noscript>.
type State =
  | "data"
  | "rcdata"
  | "rawtext"
  | "tagOpen"
  | "endTagOpen"
  | "tagName"
  | "beforeAttributeName"
  | "attributeName"
  | "afterAttributeName"
  | "beforeAttributeValue"
  | "attributeValueDoubleQuoted"
  | "attributeValueSingleQuoted"
  | "attributeValueUnquoted"
  | "afterAttributeValueQuoted"
  | "selfClosingStartTag"
  | "bogusComment"
  | "commentStart"
  | "commentStartDash"
  | "comment"
  | "commentEndDash"
  | "commentEnd"
  | "commentEndBang"
  | "doctype";

/** Where the markup written so far has left the tokenizer. */
export type Context = {
  readonly state: State;
  readonly tag: string; // name of the tag being written ("/p" for an end tag), or of the rcdata/rawtext element we are in
  readonly attr: string; // name of the attribute being written
};

/** Every template starts in text. */
export const START: Context = { state: "data", tag: "", attr: "" };

// Elements whose text the tree builder has the tokenizer read as RCDATA or RAWTEXT (<script>'s
// script-data state differs from RAWTEXT only after "<", which advance() refuses there).
// <noscript> is RAWTEXT because browsers run with scripting on.
const TEXT_ELEMENTS = new Map<string, "rcdata" | "rawtext">([
  ["title", "rcdata"],
  ["textarea", "rcdata"],
  ["style", "rawtext"],
  ["script", "rawtext"],
  ["xmp", "rawtext"],
  ["iframe", "rawtext"],
  ["noembed", "rawtext"],
  ["noframes", "rawtext"],
  ["noscript", "rawtext"],
]);

const WHITESPACE = new Set(["\t", "\n", "\f", "\r", " "]); // "\r" too: the input stream turns CR into LF
const ENDS_TAG_NAME = new Set([...WHITESPACE, "/", ">"]);
const isAsciiAlpha = (c: string) => /^[a-zA-Z]$/.test(c);
const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase()); // the tokenizer lower-cases ASCII only

// After "<!" the tokenizer looks ahead for "--", "DOCTYPE" (any ASCII case) or "[CDATA[". True when
// `ahead` stops (the markup ends) while it could still become one of them.
const isProperPrefix = (text: string, word: string) => text.length < word.length && word.startsWith(text);
const endsBeforeDeclaration = (ahead: string) =>
  isProperPrefix(ahead, "--") || isProperPrefix(lower(ahead), "doctype") || isProperPrefix(ahead, "[CDATA[");

/**
 * Reads `markup` from `context` the way the WHATWG tokenizer does and returns where it ends. Throws
 * on the markup whose context the tree builder decides instead: "<" inside a text element other
 * than its end tag (inside <svg>, or a <select> that ignores the element, a browser reads a tag
 * there), CDATA sections (read as text only inside <svg> or <math>) and <plaintext>.
 * html() reads each literal and each trusted() value as a separate part, so `markup` may stop where
 * the next part goes on. advance() therefore also throws when `markup` ends before a look-ahead can
 * decide ("<!" and part of "--", "DOCTYPE" or "[CDATA[", or part of a text element's end tag):
 * markup read in parts reaches the context it reaches read whole, or throws.
 * Exported, with START, so a test can compare it with a spec-compliant tokenizer.
 */
export function advance(context: Context, markup: string): Context {
  let { state, tag, attr } = context;
  // A start or end tag has just ended: back to text, or into the element's own text.
  const afterTag = (): State => {
    if (tag === "plaintext") throw new Error("html templates do not support <plaintext>");
    return TEXT_ELEMENTS.get(tag) ?? "data";
  };
  for (let i = 0; i < markup.length; i++) {
    const c = markup.charAt(i);
    const space = WHITESPACE.has(c);
    switch (state) {
      case "data":
        if (c === "<") state = "tagOpen";
        break;
      case "rcdata":
      case "rawtext": {
        if (c !== "<") break;
        const endTag = `</${tag}`;
        if (lower(markup.slice(i, i + endTag.length)) !== endTag || !ENDS_TAG_NAME.has(markup.charAt(i + endTag.length))) {
          throw new Error(`An html template may only write "<" inside a <${tag}> element to close it`);
        }
        state = "tagName";
        tag = `/${tag}`;
        i += endTag.length - 1;
        break;
      }
      case "tagOpen":
        if (c === "!") {
          // Markup declaration open: the next seven characters decide what "<!" opens.
          const ahead = markup.slice(i + 1, i + 8);
          if (endsBeforeDeclaration(ahead)) {
            throw new Error(`"<!${ahead}" is cut off before it shows whether it opens a comment, a DOCTYPE or a CDATA section`);
          }
          if (ahead.startsWith("--")) {
            state = "commentStart";
            i += 2;
          } else if (lower(ahead) === "doctype") {
            state = "doctype";
            i += 7;
          } else if (ahead === "[CDATA[") {
            throw new Error("html templates do not support CDATA sections");
          } else state = "bogusComment";
        } else if (c === "/") state = "endTagOpen";
        else if (isAsciiAlpha(c)) {
          state = "tagName";
          tag = lower(c);
        } else if (c === "?") state = "bogusComment";
        else {
          state = "data";
          i--; // reconsume
        }
        break;
      case "endTagOpen":
        if (isAsciiAlpha(c)) {
          state = "tagName";
          tag = `/${lower(c)}`;
        } else state = c === ">" ? "data" : "bogusComment";
        break;
      case "tagName":
        if (space) state = "beforeAttributeName";
        else if (c === "/") state = "selfClosingStartTag";
        else if (c === ">") state = afterTag();
        else tag += lower(c);
        break;
      case "beforeAttributeName":
        if (c === "/") state = "selfClosingStartTag";
        else if (c === ">") state = afterTag();
        else if (!space) {
          state = "attributeName"; // "=" here starts a name too
          attr = lower(c);
        }
        break;
      case "attributeName":
        if (space) state = "afterAttributeName";
        else if (c === "/") state = "selfClosingStartTag";
        else if (c === ">") state = afterTag();
        else if (c === "=") state = "beforeAttributeValue";
        else attr += lower(c);
        break;
      case "afterAttributeName":
        if (c === "/") state = "selfClosingStartTag";
        else if (c === ">") state = afterTag();
        else if (c === "=") state = "beforeAttributeValue";
        else if (!space) {
          state = "attributeName";
          attr = lower(c);
        }
        break;
      case "beforeAttributeValue":
        // A quote opens a value only here.
        if (c === '"') state = "attributeValueDoubleQuoted";
        else if (c === "'") state = "attributeValueSingleQuoted";
        else if (c === ">") state = afterTag();
        else if (!space) state = "attributeValueUnquoted";
        break;
      case "attributeValueDoubleQuoted":
        if (c === '"') state = "afterAttributeValueQuoted";
        break;
      case "attributeValueSingleQuoted":
        if (c === "'") state = "afterAttributeValueQuoted";
        break;
      case "attributeValueUnquoted":
        if (space) state = "beforeAttributeName";
        else if (c === ">") state = afterTag();
        break;
      case "afterAttributeValueQuoted":
      case "selfClosingStartTag":
        if (c === ">") state = afterTag();
        else {
          state = "beforeAttributeName";
          i--; // reconsume
        }
        break;
      case "bogusComment":
      case "doctype":
        if (c === ">") state = "data";
        break;
      case "commentStart":
        state = c === "-" ? "commentStartDash" : c === ">" ? "data" : "comment";
        break;
      case "commentStartDash":
        state = c === "-" ? "commentEnd" : c === ">" ? "data" : "comment";
        break;
      case "comment":
        if (c === "-") state = "commentEndDash";
        break;
      case "commentEndDash":
        state = c === "-" ? "commentEnd" : "comment";
        break;
      case "commentEnd":
        state = c === ">" ? "data" : c === "!" ? "commentEndBang" : c === "-" ? "commentEnd" : "comment";
        break;
      case "commentEndBang":
        state = c === "-" ? "commentEndDash" : c === ">" ? "data" : "comment";
        break;
    }
  }
  return { state, tag, attr };
}

// What a value may be at each state: "text" and "rcdata" escape text (text also takes markup),
// "attributes" (between attributes) takes only trusted() markup, "quotedValue" is a double-quoted
// attribute value, and "closed", "tagName" and "otherValue" take nothing at all.
type Slot = "text" | "rcdata" | "closed" | "tagName" | "attributes" | "quotedValue" | "otherValue";
const SLOT: Record<State, Slot> = {
  data: "text",
  rcdata: "rcdata",
  rawtext: "closed",
  tagOpen: "tagName",
  endTagOpen: "tagName",
  tagName: "tagName",
  beforeAttributeName: "attributes",
  attributeName: "attributes",
  afterAttributeName: "attributes",
  afterAttributeValueQuoted: "attributes",
  selfClosingStartTag: "attributes",
  beforeAttributeValue: "otherValue",
  attributeValueSingleQuoted: "otherValue",
  attributeValueUnquoted: "otherValue",
  attributeValueDoubleQuoted: "quotedValue",
  bogusComment: "closed",
  commentStart: "closed",
  commentStartDash: "closed",
  comment: "closed",
  commentEndDash: "closed",
  commentEnd: "closed",
  commentEndBang: "closed",
  doctype: "closed",
};

function inside({ state, tag }: Context): string {
  if (state === "rcdata" || state === "rawtext") return `a <${tag}> element`;
  if (state === "doctype") return "a <!DOCTYPE>";
  return SLOT[state] === "closed" ? "a comment" : "a tag";
}

// Attributes a browser fetches or navigates to: only a SafeUrl may be interpolated.
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "data", "ping", "background", "xlink:href"]);

// Attributes that run script, carry CSS, hold several URLs or hold a whole HTML document:
// no interpolation at all (a future srcset needs its own SafeSrcset type first).
const isNeverInterpolated = (attr: string) =>
  attr.startsWith("on") || attr === "style" || attr === "srcset" || attr === "imagesrcset" || attr === "srcdoc";

// SVG animation elements copy values/from/to/by into the attribute they animate, which can be the
// href of the <a> around them (<set attributeName="href" to="javascript:…">): none of their
// attributes takes an interpolated value.
const ANIMATION_ELEMENTS = new Set(["animate", "animatecolor", "animatemotion", "animatetransform", "set"]);

const isNothing = (value: Value): value is false | null | undefined => value === false || value === null || value === undefined;

const IN_TAG = "Interpolation inside a tag must be a double-quoted attribute value or trusted() markup";

function attributeValue(value: Value, { tag, attr }: Context): string {
  if (ANIMATION_ELEMENTS.has(tag)) throw new Error(`The SVG <${tag}> animation element never takes an interpolated value`);
  if (isNeverInterpolated(attr)) throw new Error(`The ${attr} attribute never takes an interpolated value`);
  if (URL_ATTRIBUTES.has(attr)) {
    if (isNothing(value)) throw new Error(`Missing URL for ${attr}`);
    const href = hrefOf(value);
    if (href === undefined) throw new Error(`The ${attr} attribute needs a SafeUrl`);
    return escapeAttr(href);
  }
  if (isNothing(value)) return "";
  if (value instanceof SafeHtml || Array.isArray(value)) throw new Error(`Markup is not allowed in the ${attr} attribute`);
  return escapeAttr(String(value));
}

/** Renders `value` for where `context` says it lands, and returns the context after it. */
function interpolate(value: Value, context: Context): [string, Context] {
  const slot = SLOT[context.state];
  if (slot === "closed") throw new Error(`Nothing may be interpolated inside ${inside(context)}`);
  if (slot === "tagName") throw new Error("Nothing may be interpolated in a tag name");
  if (slot === "otherValue") throw new Error(IN_TAG);
  if (slot === "quotedValue") return [attributeValue(value, context), context];
  if (isNothing(value)) return ["", context];
  // trusted() markup is read like the template's own text. advance() reads it as its own part, which
  // reaches the context the whole text would reach, or throws (see advance()).
  if (value instanceof TrustedHtml && slot !== "rcdata") return [value.toString(), advance(context, value.toString())];
  if (slot === "attributes") throw new Error(IN_TAG);
  if (Array.isArray(value)) {
    return value.reduce<[string, Context]>(
      ([out, at], item: Value) => {
        const [markup, next] = interpolate(item, at);
        return [out + markup, next];
      },
      ["", context],
    );
  }
  if (value instanceof SafeHtml) {
    if (slot === "rcdata") throw new Error(`Markup is not allowed inside ${inside(context)}`);
    return [value.toString(), context];
  }
  return [escapeText(String(value)), context];
}

/**
 * Tagged template that escapes every interpolation for where the WHATWG tokenizer puts it:
 * text and <title>/<textarea> text -> escapeText, double-quoted attribute values -> escapeAttr, URL
 * attributes -> SafeUrl only, between attributes -> trusted() only; tag names, other attribute
 * values, event-handler/style/srcset/srcdoc attributes, any attribute of an SVG animation element,
 * comments, doctypes and <style>/<script> content -> never. A template must end in text, so a
 * fragment cannot leave the template it is spliced into tracking the wrong context.
 */
export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0] ?? "";
  let context = advance(START, out);
  values.forEach((value, i) => {
    const [markup, after] = interpolate(value, context);
    const literal = strings[i + 1] ?? "";
    out += markup + literal;
    context = advance(after, literal);
  });
  if (context.state !== "data") throw new Error(`An html template must not end inside ${inside(context)}`);
  return new SafeHtml(out);
}
