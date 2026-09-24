import { Parser, TokenizerMode, type DefaultTreeAdapterMap, type Token } from "parse5";
import { describe, expect, it } from "vitest";
import * as htmlModule from "../src/html.ts";
import { advance, fragment, html, safeUrl, SafeHtml, START, trusted, type Context } from "../src/html.ts";

const PAYLOAD = `<img src=x onerror="alert(1)">'&`;
const JS = "javascript:alert(1)";
// Breaks out of a double-quoted attribute value unless it is escaped.
const BREAKOUT = `" onmouseover="alert(1)`;
// Breaks out of an unquoted value, or of a quoted one that was mistaken for text, without a quote.
const UNQUOTED_BREAKOUT = " onmouseover=alert(1)//";
const NEUTRALISED = "&quot; onmouseover=&quot;alert(1)";

describe("html tagged template", () => {
  it("escapes text interpolations", () => {
    expect(String(html`<p>${PAYLOAD}</p>`)).toBe(`<p>&lt;img src=x onerror="alert(1)"&gt;'&amp;</p>`);
  });

  it("escapes attribute interpolations, including quotes", () => {
    expect(String(html`<p title="${PAYLOAD}">x</p>`)).toBe(
      `<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;">x</p>`,
    );
  });

  it("knows it is still inside a tag after an earlier interpolation", () => {
    const out = String(html`<a href="${safeUrl("https://example.com")}" title="${`"><script>`}">x</a>`);
    expect(out).toBe(`<a href="https://example.com" title="&quot;&gt;&lt;script&gt;">x</a>`);
  });

  it("renders numbers and skips false, null and undefined", () => {
    expect(String(html`<p>${3}${false}${null}${undefined}</p>`)).toBe("<p>3</p>");
  });

  it("joins arrays and passes nested templates through unescaped", () => {
    const items = ["a<", "b"].map((s) => html`<li>${s}</li>`);
    expect(String(html`<ul>${items}</ul>`)).toBe("<ul><li>a&lt;</li><li>b</li></ul>");
  });

  it("allows a trusted boolean attribute between attributes", () => {
    expect(String(html`<details name="faq"${trusted(" open")}>`)).toBe(`<details name="faq" open>`);
    expect(String(html`<details name="faq"${false}>`)).toBe(`<details name="faq">`);
  });

  it("refuses a plain string where an attribute name could be injected", () => {
    expect(() => html`<p ${"onclick=alert(1)"}>x</p>`).toThrow("double-quoted attribute value");
    expect(() => html`<p class=${"x"}>x</p>`).toThrow("double-quoted attribute value");
  });

  it("requires a SafeUrl in href, src and action", () => {
    expect(() => html`<a href="${"javascript:alert(1)"}">x</a>`).toThrow("needs a SafeUrl");
    expect(() => html`<img src="${"https://example.com/a.jpg"}" alt="">`).toThrow("needs a SafeUrl");
    expect(() => html`<form action="${undefined}"></form>`).toThrow("Missing URL");
  });

  it("finds the attribute name when there are spaces around =", () => {
    expect(() => html`<a href = "${"javascript:alert(1)"}">x</a>`).toThrow("needs a SafeUrl");
  });

  it("requires a SafeUrl in every other URL attribute", () => {
    expect(() => html`<button formaction="${"javascript:alert(1)"}">x</button>`).toThrow("needs a SafeUrl");
    expect(() => html`<video poster="${"javascript:alert(1)"}"></video>`).toThrow("needs a SafeUrl");
    expect(() => html`<object data="${"javascript:alert(1)"}"></object>`).toThrow("needs a SafeUrl");
  });

  it("never interpolates into event handlers, style, srcset or srcdoc", () => {
    expect(() => html`<p onclick="${"alert(1)"}">x</p>`).toThrow("never takes an interpolated value");
    expect(() => html`<p style="${"background:red"}">x</p>`).toThrow("never takes an interpolated value");
    expect(() => html`<img srcset="${safeUrl("https://example.com/a.jpg")}" alt="">`).toThrow("never takes an interpolated value");
    expect(() => html`<iframe srcdoc="${"<script>alert(1)</script>"}"></iframe>`).toThrow("never takes an interpolated value");
  });

  it("refuses markup inside an attribute", () => {
    expect(() => html`<p title="${html`<b>x</b>`}">x</p>`).toThrow("not allowed");
  });

  it("returns SafeHtml", () => {
    expect(html`<p></p>`).toBeInstanceOf(SafeHtml);
    expect(trusted(" open")).toBeInstanceOf(SafeHtml);
  });
});

describe("html composition and context tracking", () => {
  it("refuses an html fragment between attributes, because its values were escaped as text", () => {
    expect(() => html`<a ${html` href="${JS}"`}>x</a>`).toThrow("double-quoted attribute value or trusted() markup");
    expect(() => html`<p ${html` onclick="${"alert(1)"}"`}>x</p>`).toThrow("double-quoted attribute value or trusted() markup");
    expect(() => html`<details name="faq"${html` open`}>`).toThrow("double-quoted attribute value or trusted() markup");
    expect(() => html`<details name="faq"${new SafeHtml(" open")}>`).toThrow("double-quoted attribute value or trusted() markup");
  });

  it("still allows trusted() markup or nothing between attributes", () => {
    expect(String(html`<details name="faq"${trusted(" open")}>`)).toBe(`<details name="faq" open>`);
    expect(String(html`<details name="faq"${false}${null}${undefined}>`)).toBe(`<details name="faq">`);
    expect(String(html`<input type="checkbox"${trusted(" checked")}${trusted(" disabled")}>`)).toBe(
      `<input type="checkbox" checked disabled>`,
    );
  });

  it("refuses a template that ends inside a tag or an attribute value", () => {
    expect(() => html`<a`).toThrow("must not end inside a tag");
    expect(() => html`<a href="`).toThrow("must not end inside a tag");
    expect(() => html`<a title='x`).toThrow("must not end inside a tag");
    expect(() => html`<details name="faq"${trusted(" open")}`).toThrow("must not end inside a tag");
  });

  it("refuses a partial-tag fragment spliced into text (the mirror case)", () => {
    expect(() => html`${html`<a`} href="${JS}">x</a>`).toThrow("must not end inside a tag");
    expect(() => html`${html`<p`} onclick="${"alert(1)"}">x</p>`).toThrow("must not end inside a tag");
  });

  it("knows every attribute name: it reads trusted() markup and refuses a value inside a name", () => {
    expect(() => html`<a ${trusted(" href")}="${JS}">x</a>`).toThrow("needs a SafeUrl");
    expect(() => html`<p ${trusted(" on")}click="${"alert(1)"}">x</p>`).toThrow("never takes an interpolated value");
    expect(() => html`<p "${"x"}">x</p>`).toThrow("double-quoted attribute value or trusted() markup");
  });

  it("threads the context through array items: a value after trusted() markup lands where that markup left it", () => {
    expect(() => html`${[trusted('<a href="'), JS]}">x</a>`).toThrow("needs a SafeUrl");
  });

  it("never interpolates inside a <style> or <script> element", () => {
    expect(() => html`<style>:root{--c:${"x"}}</style>`).toThrow("inside a <style> element");
    expect(() => html`<script>${"x"}</script>`).toThrow("inside a <script> element");
    expect(() => html`<SCRIPT type="application/ld+json">${new SafeHtml("{}")}</SCRIPT>`).toThrow("inside a <script> element");
    expect(() => html`<style media="print">${false}</style>`).toThrow("inside a <style> element");
    expect(() => html`${html`<style>`}${"x"}</style>`).toThrow("must not end inside a <style> element");
  });

  it("still places a whole <style> or <script> element built as SafeHtml, and escapes text after one", () => {
    const style = new SafeHtml("<style>a{color:red}</style>");
    const script = new SafeHtml(`<script type="application/ld+json">{}</script>`);
    expect(String(html`<head>${style}${script}<title>${"A & B"}</title></head>`)).toBe(
      `<head><style>a{color:red}</style><script type="application/ld+json">{}</script><title>A &amp; B</title></head>`,
    );
    expect(String(html`<style>a{}</style><p>${"<b>"}</p>`)).toBe("<style>a{}</style><p>&lt;b&gt;</p>");
  });

  it("tracks single-quoted attribute values, so a > inside one does not end the tag", () => {
    expect(String(html`<p title='a>b' class="${`" onmouseover="alert(1)`}">x</p>`)).toBe(
      `<p title='a>b' class="&quot; onmouseover=&quot;alert(1)">x</p>`,
    );
    expect(() => html`<a href='${safeUrl("https://example.com")}'>x</a>`).toThrow("double-quoted attribute value");
  });

  it("is not confused by quotes inside a comment", () => {
    expect(String(html`<!-- don't --><p title="it's > ${`" onmouseover="alert(1)`}">x</p>`)).toBe(
      `<!-- don't --><p title="it's > &quot; onmouseover=&quot;alert(1)">x</p>`,
    );
    expect(() => html`<!-- ${"x"} -->`).toThrow("inside a comment");
  });
});

describe("A5: the tracker follows the WHATWG tokenizer instead of guessing", () => {
  it("neutralises a quote inside an attribute name (<p a'b …>)", () => {
    expect(String(html`<p a'b c="it's > ${BREAKOUT}">`)).toBe(`<p a'b c="it's > ${NEUTRALISED}">`);
  });

  it("neutralises a quote inside an unquoted value (data-x=it's)", () => {
    expect(String(html`<p data-x=it's c="it's > ${BREAKOUT}">`)).toBe(`<p data-x=it's c="it's > ${NEUTRALISED}">`);
  });

  it("ends a comment at <!--> as browsers do", () => {
    expect(String(html`<!--><p title="--> ${BREAKOUT}">`)).toBe(`<!--><p title="--> ${NEUTRALISED}">`);
  });

  it("ends a comment at --!> as browsers do", () => {
    expect(String(html`<!-- a --!><p title="--> ${BREAKOUT}">`)).toBe(`<!-- a --!><p title="--> ${NEUTRALISED}">`);
  });

  it("ends a comment at <!---> as browsers do", () => {
    expect(String(html`<!---><p title="${BREAKOUT}">`)).toBe(`<!---><p title="${NEUTRALISED}">`);
  });

  it("fails closed at a tag-name position, even for trusted() markup or nothing", () => {
    expect(() => html`<${trusted("script")}>${"alert(1)"}</script>`).toThrow("Nothing may be interpolated in a tag name");
    expect(() => html`<${"img src=x onerror=alert(1)"}>`).toThrow("Nothing may be interpolated in a tag name");
    expect(() => html`</${"p"}>`).toThrow("Nothing may be interpolated in a tag name");
    expect(() => html`<p${false}>`).toThrow("Nothing may be interpolated in a tag name");
    // The A4 tests' literals with no space after the tag name are tag-name positions too.
    expect(() => html`<a${html` href="${JS}"`}>x</a>`).toThrow("Nothing may be interpolated in a tag name");
    expect(() => html`<p${html` onclick="${"alert(1)"}"`}>x</p>`).toThrow("Nothing may be interpolated in a tag name");
    expect(() => html`<details${html` open`}>`).toThrow("Nothing may be interpolated in a tag name");
    expect(() => html`<details${new SafeHtml(" open")}>`).toThrow("Nothing may be interpolated in a tag name");
    expect(() => html`<details${trusted(" open")}`).toThrow("Nothing may be interpolated in a tag name");
    expect(() => html`<a${trusted(" href")}="${JS}">x</a>`).toThrow("Nothing may be interpolated in a tag name");
  });

  it("treats a=b=\"…\" as an unquoted value, where nothing may be interpolated", () => {
    expect(() => html`<p a=b="${UNQUOTED_BREAKOUT}">`).toThrow("double-quoted attribute value");
  });

  it("knows a no-break space does not end a tag name", () => {
    expect(() => html`<p title="${UNQUOTED_BREAKOUT}">`).toThrow("Nothing may be interpolated in a tag name");
  });

  it("reads trusted() markup like template text", () => {
    expect(() => html`${trusted("<script>")}${"alert(1)"}</script>`).toThrow("inside a <script> element");
    expect(String(html`<a ${trusted('title="')}>${BREAKOUT}">x</a>`)).toBe(`<a title=">${NEUTRALISED}">x</a>`);
    expect(() => html`<a ${trusted("hr")}ef="${JS}">x</a>`).toThrow("needs a SafeUrl");
  });

  it("tracks <title> and <textarea> text: text is escaped, markup is refused", () => {
    expect(String(html`<title>${"</title><script>alert(1)</script>"}</title>`)).toBe(
      "<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>",
    );
    expect(String(html`<textarea>${["a", "<b>"]}</textarea>`)).toBe("<textarea>a&lt;b&gt;</textarea>");
    expect(() => html`<title>${html`<b>x</b>`}</title>`).toThrow("Markup is not allowed inside a <title> element");
    expect(() => html`<title>${"x"}`).toThrow("must not end inside a <title> element");
  });

  it("compares attribute names ASCII-lower-cased, as the tokenizer does", () => {
    expect(() => html`<A HREF="${JS}">x</A>`).toThrow("needs a SafeUrl");
    expect(() => html`<link IMAGESRCSET="${"x"}">`).toThrow("never takes an interpolated value");
    expect(() => html`<svg><use xlink:href="${JS}"/></svg>`).toThrow("needs a SafeUrl");
  });
});

describe("A5 round 2: no attribute of an SVG animation element takes a value", () => {
  // <animate> and <set> copy values/from/to/by into the attribute they animate, which can be the
  // href of the <a> around them: a plain string there becomes a link target that runs script.
  const REFUSED = "animation element never takes an interpolated value";

  it("refuses the values, from, to and by that would animate an href", () => {
    expect(() => html`<svg><a><animate attributeName="href" values="${JS}"/><text>x</text></a></svg>`).toThrow(REFUSED);
    expect(() => html`<svg><a><set attributeName="href" to="${JS}"/><text>x</text></a></svg>`).toThrow(REFUSED);
    expect(() => html`<svg><a><animate attributeName="xlink:href" from="${JS}" to="#x"/></a></svg>`).toThrow(REFUSED);
    expect(() => html`<svg><a><animate attributeName="href" by="${JS}"/></a></svg>`).toThrow(REFUSED);
  });

  it("refuses every other attribute of one, and a SafeUrl or nothing as well", () => {
    expect(() => html`<svg><a><set attributeName="${"href"}" to="javascript:void(0)"/></a></svg>`).toThrow(REFUSED);
    expect(() => html`<svg><animate href="${fragment("link")}" attributeName="href"/></svg>`).toThrow(REFUSED);
    expect(() => html`<svg><set dur="${"1s"}"/></svg>`).toThrow(REFUSED);
    expect(() => html`<svg><set to="${safeUrl("https://example.com/")}"/></svg>`).toThrow(REFUSED);
    expect(() => html`<svg><set to="${false}"/></svg>`).toThrow(REFUSED);
  });

  it("covers every SVG animation element, in any case, even when trusted() markup opens it", () => {
    expect(() => html`<svg><animateTransform by="${JS}"/></svg>`).toThrow(REFUSED);
    expect(() => html`<svg><animateMotion values="${JS}"/></svg>`).toThrow(REFUSED);
    expect(() => html`<svg><animateColor to="${JS}"/></svg>`).toThrow(REFUSED);
    expect(() => html`<svg><SET TO="${JS}"/></svg>`).toThrow(REFUSED);
    expect(() => html`<svg><a>${trusted("<set")} to="${JS}"/></a></svg>`).toThrow(REFUSED);
  });
});

// ---- Differential test against parse5 (MIT), a spec-compliant tokenizer and tree builder ----

// Marks an interpolation point in a corpus shape.
const _ = null;
/** The literal parts of a template, split where values would be interpolated. */
const shape = (strings: TemplateStringsArray, ..._points: unknown[]): readonly string[] => strings;
/** A unique marker (lower-case ASCII letters, so it is text, a name or a value wherever it lands). */
const marker = (i: number) => `zqmark${String.fromCharCode(97 + i)}`;

// parse5's tree builder switches its tokenizer into RCDATA/RAWTEXT for <title>, <style> and the
// rest exactly as a browser does, so the recorder reads text mode from the tokenizer itself.
const TEXT_MODES = new Map<number, string>([
  [TokenizerMode.RCDATA, "rcdata"],
  [TokenizerMode.RAWTEXT, "rawtext"],
  [TokenizerMode.SCRIPT_DATA, "rawtext"],
  [TokenizerMode.PLAINTEXT, "plaintext"],
]);

/** Records, for each marker, where parse5's tokenizer put it. */
class MarkerRecorder extends Parser<DefaultTreeAdapterMap> {
  readonly landed = new Map<string, string>();
  readonly #source: string;
  readonly #markers: readonly string[];
  #text = "text";

  constructor(source: string, markers: readonly string[]) {
    super({ sourceCodeLocationInfo: true });
    this.#source = source;
    this.#markers = markers;
  }

  #see(where: string, label: (m: string) => string): void {
    for (const m of this.#markers) if (where.includes(m) && !this.landed.has(m)) this.landed.set(m, label(m));
  }

  /** `element` is "<p>" for a start tag and "</p>" for an end tag. */
  #seeTag(token: Token.TagToken, element: string): void {
    this.#see(token.tagName, () => "tag name");
    for (const { name, value } of token.attrs) {
      const where = (m: string) => (name.startsWith(m) ? "new attribute name" : `attribute name after ${name.slice(0, name.indexOf(m))}`);
      this.#see(name, (m) => `${where(m)} in ${element}`);
      this.#see(value, () => `${this.#quote(token, name)} value of ${name} in ${element}`);
    }
  }

  // The token does not keep the quote, so read it from the source: name, "=", then the quote if any.
  #quote(token: Token.TagToken, name: string): string {
    const at = token.location?.attrs?.[name];
    const source = at ? this.#source.slice(at.startOffset, at.endOffset) : "";
    const found = /^[\t\n\f\r ]*=[\t\n\f\r ]*(["']?)/.exec(source.slice(name.length));
    if (!found) throw new Error(`parse5 gave no source location for the value of ${name}: ${JSON.stringify(source)}`);
    return found[1] || "unquoted";
  }

  override onStartTag(token: Token.TagToken): void {
    this.#seeTag(token, `<${token.tagName}>`);
    super.onStartTag(token);
    const mode = TEXT_MODES.get(this.tokenizer.state);
    if (mode) this.#text = `${mode} <${token.tagName}>`;
  }

  override onEndTag(token: Token.TagToken): void {
    this.#seeTag(token, `</${token.tagName}>`);
    this.#text = "text"; // inside RCDATA/RAWTEXT the only end tag the tokenizer emits is the closing one
    super.onEndTag(token);
  }

  override onCharacter(token: Token.CharacterToken): void {
    this.#see(token.chars, () => this.#text);
    super.onCharacter(token);
  }

  override onComment(token: Token.CommentToken): void {
    this.#see(token.data, () => "comment");
    super.onComment(token);
  }

  override onDoctype(token: Token.DoctypeToken): void {
    this.#see(`${token.name} ${token.publicId} ${token.systemId}`, () => "doctype");
    super.onDoctype(token);
  }
}

/** A shape's literals joined, with the marker for each interpolation point in its place. */
const sourceOf = (literals: readonly string[]): string =>
  literals.map((literal, i) => literal + (i < literals.length - 1 ? marker(i) : "")).join("");

/** Where parse5 puts a marker placed at each interpolation point. */
function parse5Contexts(literals: readonly string[]): string[] {
  const markers = literals.slice(1).map((_literal, i) => marker(i));
  const source = sourceOf(literals);
  const recorder = new MarkerRecorder(source, markers);
  recorder.tokenizer.write(source, true);
  return markers.map((m) => recorder.landed.get(m) ?? "lost");
}

/** The same labels for our tracker's context. */
function label({ state, tag, attr }: Context): string {
  const element = `<${tag}>`; // tag is "/p" in an end tag, so this is "</p>" there
  switch (state) {
    case "data":
      return "text";
    case "rcdata":
    case "rawtext":
      return `${state} <${tag}>`;
    case "tagOpen":
    case "endTagOpen":
    case "tagName":
      return "tag name";
    case "beforeAttributeName":
    case "afterAttributeName":
    case "afterAttributeValueQuoted":
    case "selfClosingStartTag":
      return `new attribute name in ${element}`;
    case "attributeName":
      return `attribute name after ${attr} in ${element}`;
    case "beforeAttributeValue":
    case "attributeValueUnquoted":
      return `unquoted value of ${attr} in ${element}`;
    case "attributeValueDoubleQuoted":
      return `" value of ${attr} in ${element}`;
    case "attributeValueSingleQuoted":
      return `' value of ${attr} in ${element}`;
    case "doctype":
      return "doctype";
    default:
      return "comment";
  }
}

/** Our tracker's context at each interpolation point, reading the same markers parse5 reads. */
function ourContexts(literals: readonly string[]): string[] {
  let context = advance(START, literals[0] ?? "");
  return literals.slice(1).map((literal, i) => {
    const here = label(context);
    context = advance(advance(context, marker(i)), literal);
    return here;
  });
}

const CORPUS: readonly (readonly string[])[] = [
  // Text, and "<" that does not open a tag.
  shape`${_}`,
  shape`<p>${_}</p>${_}`,
  shape`a < ${_}`,
  shape`a <3 ${_}`,
  shape`<<p>${_}`,
  // Tag-name positions.
  shape`<${_}>`,
  shape`<p${_}>`,
  shape`a<${_} b="c">`,
  shape`</${_}>`,
  shape`</p${_}>`,
  // End tags (their attributes are tokenized too) and bogus comments.
  shape`</>${_}`,
  shape`</ ${_}>${_}`,
  shape`</3 ${_}>${_}`,
  shape`</p ${_}>`,
  shape`</p title="${_}">${_}`,
  shape`<? ${_} ?>${_}`,
  shape`<!x ${_}>${_}`,
  shape`<!- ${_} ->${_}`,
  shape`<![cdata[ ${_} ]]>${_}`,
  // Comments, with every ending browsers accept.
  shape`<!--${_}-->${_}`,
  shape`<!---${_}-->${_}`,
  shape`<!-->${_}`,
  shape`<!--->${_}`,
  shape`<!---->${_}`,
  shape`<!-- a --!>${_}`,
  shape`<!-- a --!-- ${_} -->${_}`,
  shape`<!-- a --!-> ${_} -->${_}`,
  shape`<!-- a -- ${_} --->${_}`,
  shape`<!-- a -!> ${_} -->`,
  shape`<!-- a -- > ${_} -->`,
  shape`<!-- <!-- ${_} --> ${_}`,
  shape`<!-- a- ${_}- -->${_}`,
  shape`<!--><p title="--> ${_}">`,
  shape`<!-- a --!><p title="--> ${_}">`,
  shape`<!---><p title="${_}">`,
  shape`<!-- don't --><p title="it's > ${_}">`,
  // DOCTYPE: every DOCTYPE state ends at ">", even inside a quoted identifier.
  shape`<!DOCTYPE html>${_}`,
  shape`<!doctype ${_}>`,
  shape`<!DOCTYPE html PUBLIC "a>b" ${_}`,
  shape`<!DocType html SYSTEM 'x'>${_}`,
  // Quotes inside attribute names.
  shape`<p a'b c="it's > ${_}">`,
  shape`<p a"b c='x ${_}'>`,
  shape`<p "${_}">`,
  shape`<p '=x ${_}>`,
  shape`<p a<b="${_}">`,
  // Quotes inside unquoted values, and a=b="…".
  shape`<p data-x=it's c="it's > ${_}">`,
  shape`<p a=b"c d="${_}">`,
  shape`<p a=b'c ${_}>`,
  shape`<p a=b="${_}">`,
  shape`<p a=b='x' c="${_}">`,
  shape`<p a=${_}>`,
  shape`<p a=x${_}>`,
  shape`<p a=/b="${_}">`,
  // Double, single and unquoted values.
  shape`<p title="${_}" class='${_}' id=${_}>`,
  shape`<p title="a'b ${_}">`,
  shape`<p title='a"b ${_}'>`,
  shape`<p title="a>b" class="${_}">${_}`,
  shape`<p title='a>b' class="${_}">`,
  shape`<p title=""${_}>`,
  shape`<p title=''/${_}>`,
  shape`<p title="x"/>${_}`,
  shape`<p a=b>${_}`,
  shape`<p a=>${_}`,
  // Whitespace: only tab, LF, FF, CR and space separate; NBSP and VT do not.
  shape`<p\ttitle="${_}">`,
  shape`<p\ftitle="${_}">`,
  shape`<p\rtitle="${_}">`,
  shape`<p\r\ntitle\r\n=\r\n"${_}">`,
  shape`<p title="${_}">`,
  shape`<p title\u000b="${_}">`,
  shape`<p title = '${_}'>`,
  shape`<p \n\n a \t = \f ${_}>`,
  // Attribute names, self-closing tags and case.
  shape`<p ${_}>`,
  shape`<p a ${_}>`,
  shape`<p a >${_}`,
  shape`<p a${_}>`,
  shape`<p =${_}>`,
  shape`<p a/b="${_}">`,
  shape`<P CLASS="${_}" ${_}>`,
  shape`<p Key="${_}">`,
  shape`<br/${_}>`,
  shape`<br / ${_}>`,
  shape`<img src="x"/${_}>`,
  // Raw text (<style>, <script> and friends) and RCDATA (<title>, <textarea>).
  shape`<style>${_}</style>${_}`,
  shape`<script>${_}</script>${_}`,
  shape`<SCRIPT type="application/ld+json">${_}</SCRIPT >${_}`,
  shape`<style/>${_}</style>`,
  shape`<script>"</script>"${_}`,
  shape`<style>a'b</style>${_}`,
  shape`<style>p{content:"x"}</style ><p title="${_}">`,
  shape`<style>a{}</style/>${_}`,
  shape`<style>a</style foo="x>y">${_}`,
  shape`<title>it's "quoted" ${_}</title>${_}`,
  shape`<Title>${_}</TITLE\t>${_}`,
  shape`<textarea>${_}</textarea>`,
  shape`<xmp>${_}</xmp>`,
  shape`<iframe>${_}</iframe>`,
  shape`<noembed>${_}</noembed>`,
  shape`<noframes>${_}</noframes>`,
  shape`<noscript>${_}</noscript>`,
  // SVG animation elements, whose attributes the tracker must place on the right element. <svg> is
  // safe in this corpus only because none of these shapes has a text element or CDATA, the two
  // things foreign content tokenizes differently.
  shape`<svg><a><animate attributeName="href" values="${_}"/></a></svg>${_}`,
  shape`<svg><a><set attributeName=href to='${_}'/></a></svg>`,
  shape`<svg><animateTransform by=${_} /></svg>`,
  shape`<SVG><AnimateMotion FROM = "${_}"></SVG>`,
  shape`<svg><a href="#x" ${_}><animate ${_}/></a></svg>`,
  shape`<svg><animate a'b to="${_}"/></svg>`,
];

describe("A5: the tracker agrees with parse5 8.0.1 at every interpolation point (differential)", () => {
  it("has a corpus of at least 40 shapes, and parse5 finds every marker", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
    expect(CORPUS.flatMap(parse5Contexts)).not.toContain("lost");
  });

  for (const literals of CORPUS) {
    it(`agrees on ${JSON.stringify(literals.join("${…}"))}`, () => {
      expect(ourContexts(literals)).toEqual(parse5Contexts(literals));
    });
  }
});

describe("A5: fails closed where the tree, not the tokenizer, decides the context", () => {
  it("refuses '<' inside a text element, which <svg> or <select> would read as a tag", () => {
    // The same literal lands in text or in an attribute value depending on an enclosing <svg>.
    expect(parse5Contexts(shape`<style><p title="</style>${_}">`)).toEqual(["text"]);
    expect(parse5Contexts(shape`<svg><style><p title="</style>${_}">`)).toEqual([`" value of title in <p>`]);
    expect(() => html`<svg><style><p title="</style>${BREAKOUT}">`).toThrow(`"<" inside a <style> element`);
    expect(parse5Contexts(shape`<svg><title><p title="</title>${_}">`)).toEqual([`" value of title in <p>`]);
    expect(() => html`<svg><title><p title="</title>${BREAKOUT}">`).toThrow(`"<" inside a <title> element`);
    expect(parse5Contexts(shape`<title><p title="</title><script>${_}</script>`)).toEqual(["rawtext <script>"]);
    expect(() => html`<title><p title="</title><script>${"alert(1)//"}"></script>`).toThrow(`"<" inside a <title> element`);
    expect(() => html`<style>a</styles>b</style>`).toThrow(`"<" inside a <style> element`);
  });

  it("refuses a text element that a <select> would ignore", () => {
    expect(parse5Contexts(shape`<select><style>${_}</style></select>`)).toEqual(["text"]);
    expect(() => html`<select><style>${"x"}</style></select>`).toThrow("inside a <style> element");
  });

  it("refuses script-data escapes, where </script> may not end the script", () => {
    expect(parse5Contexts(shape`<script>/*<!--<script>*/;/*</script>*/${_}</script>`)).toEqual(["rawtext <script>"]);
    expect(() => html`<script>/*<!--<script>*/;/*</script>*/${"alert(1)"}</script>`).toThrow(`"<" inside a <script> element`);
  });

  it("refuses CDATA sections and <plaintext>", () => {
    expect(parse5Contexts(shape`<svg><![CDATA[${_}]]></svg>`)).toEqual(["text"]);
    expect(parse5Contexts(shape`<![CDATA[${_}]]>`)).toEqual(["comment"]);
    expect(() => html`<svg><![CDATA[${"x"}]]></svg>`).toThrow("CDATA");
    expect(parse5Contexts(shape`<plaintext>${_}</plaintext>`)).toEqual(["plaintext <plaintext>"]);
    expect(() => html`<plaintext>${"x"}`).toThrow("<plaintext>");
  });
});

// ---- A5 round 3: html() reads each literal and each trusted() value as its own part ----

const CUT_OFF = "is cut off before it shows whether it opens a comment, a DOCTYPE or a CDATA section";

describe("A5 round 3: a look-ahead cut off by the end of a part fails closed", () => {
  // Breaks out of an unquoted value into a new attribute, with no quote to escape.
  const LIVE = "x onmouseover=alert(1) ";

  it('refuses trusted() markup that ends in "<!" or "<!-", which the next part can make a comment', () => {
    // Read whole, "<!--" opens a comment that "-- >" does not end, so the value lands unquoted.
    expect(parse5Contexts(shape`<!-- > <p title="--> <p a=${_}">`)).toEqual(["unquoted value of a in <p>"]);
    expect(() => html`${trusted("<!-")}- > <p title="--> <p a=${LIVE}">`).toThrow(CUT_OFF);
    expect(() => html`${[trusted("<b>"), trusted("<!")]}-- > <p title="--> <p a=${LIVE}">`).toThrow(CUT_OFF);
  });

  it('refuses trusted() markup that ends in "<![" inside <svg>, which the next part can make a CDATA section', () => {
    expect(parse5Contexts(shape`<svg><![CDATA[> <p title="]]><p a=${_}">`)).toEqual(["unquoted value of a in <p>"]);
    expect(() => html`<svg>${trusted("<![")}CDATA[> <p title="]]><p a=${LIVE}">`).toThrow(CUT_OFF);
  });

  it('refuses "<!" followed by only a proper prefix of "--", "DOCTYPE" or "[CDATA[" at the end of a part', () => {
    for (const rest of ["", "-", "d", "DOC", "docTYP", "[", "[CDATA"]) {
      expect(() => advance(START, `<!${rest}`), rest).toThrow(CUT_OFF);
    }
  });

  it("reads a markup declaration as before when the part holds enough to decide it", () => {
    expect(advance(START, "<!--").state).toBe("commentStart");
    expect(advance(START, "<!-x").state).toBe("bogusComment");
    expect(advance(START, "<!DocType").state).toBe("doctype");
    expect(advance(START, "<!docx").state).toBe("bogusComment");
    expect(advance(START, "<![cdata").state).toBe("bogusComment"); // "[CDATA[" is matched case-sensitively
    expect(advance(START, "<!x").state).toBe("bogusComment");
    expect(String(html`${trusted("<!-- a -->")}<p>${"b"}</p>`)).toBe("<!-- a --><p>b</p>");
  });
});

/** A small seeded generator (mulberry32), so the random corpus is the same on every run. */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("A5 round 3: markup read in two parts reaches the context it reaches read whole, or throws", () => {
  const read = (...parts: string[]): string => {
    try {
      return JSON.stringify(parts.reduce((context, part) => advance(context, part), START));
    } catch {
      return "throws";
    }
  };

  /** Every split of every prefix of `markup` that does not throw and reads differently from the prefix read whole. */
  function splitMismatches(markup: string): string[] {
    const found: string[] = [];
    for (let end = 0; end <= markup.length; end++) {
      const whole = read(markup.slice(0, end));
      for (let at = 0; at <= end; at++) {
        const split = read(markup.slice(0, at), markup.slice(at, end));
        if (split !== "throws" && split !== whole) {
          found.push(`${JSON.stringify(markup.slice(0, at))} + ${JSON.stringify(markup.slice(at, end))}: ${split}, whole ${whole}`);
        }
      }
    }
    return found;
  }

  const summary = (mismatches: readonly string[]) => ({ count: mismatches.length, first: mismatches.slice(0, 3) });
  const NONE = { count: 0, first: [] };

  it("holds at every split of every prefix of the differential corpus", () => {
    expect(summary(CORPUS.map(sourceOf).flatMap(splitMismatches))).toEqual(NONE);
  });

  it("holds at every split of every prefix of 1,000 seeded random strings of HTML-significant pieces", () => {
    const PIECES = [
      "<", "</", "<!", "<!-", "!", "-", "--", ">", "/", "=", '"', "'", " ", "\n", "?", "[", "[CDATA[", "CDA", "TA[", "]]>",
      "doc", "DOCTYPE", "type", "a", "p", "title", "style", "<p ", "title=", "<svg>", "<style>", "</style>", "<title>", "</title>",
    ];
    const random = seededRandom(20260924);
    const pick = () => PIECES[Math.floor(random() * PIECES.length)] ?? "";
    const strings = Array.from({ length: 1000 }, () => Array.from({ length: 1 + Math.floor(random() * 8) }, pick).join(""));
    expect(summary(strings.flatMap(splitMismatches))).toEqual(NONE);
  });
});

describe("safeUrl", () => {
  it("accepts http, https, tel and mailto", () => {
    expect(String(safeUrl("http://example.com/"))).toBe("http://example.com/");
    expect(String(safeUrl("https://example.com/a?b=1"))).toBe("https://example.com/a?b=1");
    expect(String(safeUrl("tel:+15125550142"))).toBe("tel:+15125550142");
    expect(String(safeUrl("mailto:a@example.com"))).toBe("mailto:a@example.com");
  });
  it("throws on javascript: and friends", () => {
    expect(() => safeUrl("javascript:alert(1)")).toThrow("Unsafe URL rejected");
    expect(() => safeUrl(" JAVASCRIPT:alert(1)")).toThrow("Unsafe URL rejected");
    expect(() => safeUrl("http://example.com", ["https:"])).toThrow("Unsafe URL rejected");
  });
  it("is the only way (with fragment) to make a SafeUrl: the class is not exported", () => {
    expect(Object.keys(htmlModule)).not.toContain("SafeUrl");
  });
  it("cannot be minted at runtime through safeUrl(x).constructor", () => {
    const SafeUrlClass = safeUrl("https://example.com/").constructor as new (...args: unknown[]) => unknown;
    expect(() => new SafeUrlClass(JS)).toThrow("Only safeUrl() and fragment() can make a SafeUrl");
    expect(() => new SafeUrlClass(Symbol("SafeUrl"), JS)).toThrow("Only safeUrl() and fragment() can make a SafeUrl");
  });
  it("cannot be switched off by patching the class that safeUrl(x).constructor exposes", () => {
    const SafeUrlClass = safeUrl("https://example.com/").constructor as unknown as Record<string, unknown>;
    const saved = Object.getOwnPropertyDescriptor(SafeUrlClass, "hrefOf");
    try {
      SafeUrlClass.hrefOf = String;
      expect(() => html`<a href="${JS}">x</a>`).toThrow("needs a SafeUrl");
      expect(() => html`<form action="${"javascript:alert(2)"}"></form>`).toThrow("needs a SafeUrl");
    } finally {
      if (saved) Object.defineProperty(SafeUrlClass, "hrefOf", saved);
      else delete SafeUrlClass.hrefOf;
    }
    // Nothing else to patch either: the class has no static members.
    expect(Object.getOwnPropertyNames(SafeUrlClass).sort()).toEqual(["length", "name", "prototype"]);
  });
  it("refuses an object that only borrows SafeUrl's prototype", () => {
    const forged: unknown = Object.assign(Object.create(Object.getPrototypeOf(fragment("x")) as object) as object, {
      toString: () => JS,
    });
    expect(() => html`<a href="${forged as ReturnType<typeof safeUrl>}">x</a>`).toThrow("needs a SafeUrl");
  });
  it("escapes & in a URL attribute", () => {
    expect(String(html`<a href="${safeUrl("https://example.com/?a=1&b=2")}">x</a>`)).toBe(
      `<a href="https://example.com/?a=1&amp;b=2">x</a>`,
    );
  });
});

describe("fragment", () => {
  it("builds an in-page link to one of our ids", () => {
    expect(String(html`<a href="${fragment("service-area")}">x</a>`)).toBe(`<a href="#service-area">x</a>`);
  });
  it("rejects anything that is not a plain id", () => {
    expect(() => fragment(`x" onclick="y`)).toThrow("Invalid fragment id");
  });
});
