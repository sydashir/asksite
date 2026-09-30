import { describe, expect, it } from "vitest";
import { MAX_PART_HEADER_BYTES, MAX_PARTS, multipartBoundary, multipartShapeProblem } from "../../src/worker/multipart.ts";
import { BROWSER_BOUNDARIES, blinkBoundary, browserContentType, browserMultipart, encode, geckoBoundary, joined, webKitBoundary, type BrowserPart } from "../support/browsers.ts";

// A cheap look at a multipart body before formData() parses it (P4-15 d): more parts than an upload
// has, or a part whose headers run on for kilobytes, are refused before the parser spends seconds on them.
// The look must find the parts where workerd's parser finds them (P4-15 review I1, I2): the boundary is read
// from the one Content-Type form browsers send, and a delimiter counts only at the body's start or after a
// line feed, as in the parser.

// Blink's and WebKit's shape: the prefix plus 16 alphanumerics (test/support/browsers.ts cites the sources).
const BOUNDARY = "----WebKitFormBoundary7MA4YWxkTrZu0gWq";

const filePart = (content: string, filename = "photo.jpg"): BrowserPart => ({ name: "file", filename, type: "image/jpeg", content: encode(content) });
const fieldPart = (name: string, value: string): BrowserPart => ({ name, value });

describe("multipartBoundary", () => {
  it("reads the boundary of the form browsers send: multipart/form-data; boundary=<1 to 70 of RFC 2046's bcharsnospace>", () => {
    // WebKit (Chrome, Safari, Playwright), Firefox, Node's undici, every bcharsnospace character, the shortest, the longest.
    for (const boundary of [BOUNDARY, "----geckoformboundary4e1d6b0f8c6a2b8f1c9e", "----formdata-undici-002991233162", "0123456789'()+_,-./:=?AZaz", "b", "x".repeat(70)]) {
      expect(multipartBoundary(`multipart/form-data; boundary=${boundary}`)).toBe(boundary);
    }
    // The parser reads the names whatever their case, and the space after the ";" is optional.
    expect(multipartBoundary("Multipart/Form-Data;BOUNDARY=abc")).toBe("abc");
  });

  it("is null for any other form, so the guard never counts with another boundary than formData() parses with", () => {
    for (const contentType of [
      // RFC 2046 5.1.1: a boundary "must be no longer than 70 characters".
      `multipart/form-data; boundary=${"x".repeat(71)}`,
      // The parser reads REAL from each of these three; a looser read found DECOY", zz" and RE\AL.
      'multipart/form-data; x="; boundary=DECOY"; boundary=REAL',
      'multipart/form-data; x="a;boundary=zz"; boundary=real',
      'multipart/form-data; boundary="RE\\AL"',
      'multipart/form-data; boundary="abc"',
      "multipart/form-data; boundary=abc; charset=utf-8",
      "multipart/form-data; charset=utf-8; boundary=abc",
      "multipart/form-data; boundary=a b",
      "multipart/form-data; boundary=",
      "multipart/form-data",
      "multipart/form-data;",
      "application/json",
    ]) {
      expect(multipartBoundary(contentType), contentType).toBeNull();
    }
  });
});

describe("multipartShapeProblem", () => {
  it("passes an upload: one file part, with or without a few fields, whose content may hold dashes and the boundary's first letters", () => {
    expect(multipartShapeProblem(browserMultipart(BOUNDARY, [filePart("\xff\xd8\xff--------\r\n\r\n----WebKit")]), BOUNDARY)).toBeNull();
    const fields = Array.from({ length: MAX_PARTS - 1 }, (_, i) => fieldPart(`field${i}`, "x"));
    expect(multipartShapeProblem(browserMultipart(BOUNDARY, [...fields, filePart("data")]), BOUNDARY)).toBeNull();
  });

  it(`refuses more than MAX_PARTS (${MAX_PARTS}) parts, without reading past the part that is one too many`, () => {
    const parts = Array.from({ length: MAX_PARTS + 1 }, (_, i) => fieldPart(`field${i}`, "x"));
    expect(multipartShapeProblem(browserMultipart(BOUNDARY, parts), BOUNDARY)).toBe("too_many_parts");
    // The closing delimiter is not a part.
    expect(multipartShapeProblem(browserMultipart(BOUNDARY, parts.slice(0, MAX_PARTS)), BOUNDARY)).toBeNull();
  });

  it(`refuses a part whose headers do not end within MAX_PART_HEADER_BYTES (${MAX_PART_HEADER_BYTES})`, () => {
    // The headers end where the blank line (CRLF CRLF) starts, so a part whose header text is exactly the limit passes.
    // A body of one file part with this filename, and the length of that part's headers (its delimiter line to the blank line).
    const withFilename = (filename: string): Uint8Array => browserMultipart(BOUNDARY, [filePart("data", filename)]);
    const headerOf = (body: Uint8Array): number => new TextDecoder().decode(body).indexOf("\r\n\r\n") - `--${BOUNDARY}\r\n`.length;
    const fits = withFilename("a".repeat(MAX_PART_HEADER_BYTES - headerOf(withFilename(""))));
    expect(headerOf(fits)).toBe(MAX_PART_HEADER_BYTES);
    expect(multipartShapeProblem(fits, BOUNDARY)).toBeNull();
    const over = withFilename("a".repeat(MAX_PART_HEADER_BYTES - headerOf(withFilename("")) + 1));
    expect(headerOf(over)).toBe(MAX_PART_HEADER_BYTES + 1);
    expect(multipartShapeProblem(over, BOUNDARY)).toBe("part_header_too_long");
    // A part with no blank line at all (a header that is the whole body).
    expect(multipartShapeProblem(encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${"a".repeat(2 * MAX_PART_HEADER_BYTES)}`), BOUNDARY)).toBe("part_header_too_long");
  });

  it("refuses a body that does not start with its first delimiter: no delimiter, an empty body, or a preamble first", () => {
    expect(multipartShapeProblem(encode("not multipart at all"), BOUNDARY)).toBe("no_leading_delimiter");
    expect(multipartShapeProblem(new Uint8Array(), BOUNDARY)).toBe("no_leading_delimiter");
    // RFC 2046 5.1.1 allows a preamble but says it "should generally be left blank"; no browser sends one, and the
    // parser's search for the first delimiter across it costs the preamble's length times the boundary's.
    expect(multipartShapeProblem(joined(encode("preamble\r\n"), browserMultipart(BOUNDARY, [filePart("data")])), BOUNDARY)).toBe("no_leading_delimiter");
  });

  it("counts a delimiter only at a line start, as the parser does: a --boundary-- inside a line does not end the body", () => {
    const fields = Array.from({ length: MAX_PARTS }, (_, i) => fieldPart(`field${i}`, "x"));
    expect(multipartShapeProblem(browserMultipart(BOUNDARY, [fieldPart("note", `xx--${BOUNDARY}--yy`), ...fields]), BOUNDARY)).toBe("too_many_parts");
    // Nor does a --boundary inside a line start a part.
    const inLine = Array.from({ length: MAX_PARTS + 1 }, () => `x--${BOUNDARY}\r\n`).join("");
    expect(multipartShapeProblem(browserMultipart(BOUNDARY, [filePart(inLine)]), BOUNDARY)).toBeNull();
  });

  it("does not stop at a close delimiter: every delimiter line after it counts too", () => {
    // Browsers send nothing after the close. Counting every delimiter line keeps the count at or above the
    // parser's parts, whatever it makes of the lines around a close.
    const after = Array.from({ length: MAX_PARTS }, (_, i) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="late${i}"\r\n\r\nx\r\n`).join("");
    expect(multipartShapeProblem(joined(browserMultipart(BOUNDARY, [filePart("data")]), encode(after)), BOUNDARY)).toBe("too_many_parts");
  });

  it("reads bare LF line ends as the parser does: a delimiter after a LF counts, and headers may end with LF LF", () => {
    expect(multipartShapeProblem(browserMultipart(BOUNDARY, [filePart("data", "a.jpg")], "\n"), BOUNDARY)).toBeNull();
    const fields = Array.from({ length: MAX_PARTS + 1 }, (_, i) => fieldPart(`field${i}`, "x"));
    expect(multipartShapeProblem(browserMultipart(BOUNDARY, fields, "\n"), BOUNDARY)).toBe("too_many_parts");
  });

  describe("reads each body byte a bounded number of times, whatever the body holds", () => {
    // workerd's own delimiter search costs the body's length times the boundary's; the guard's must not. Counted,
    // not timed: a Proxy counts every byte the guard reads, so the bound holds on any machine.
    const boundary = `${"-".repeat(69)}x`; // RFC 2046's longest, whose dashes match a body of dashes almost whole
    const size = 64 * 1024;
    const fills: Array<[name: string, unit: string]> = [
      ["dashes", "-"],
      ["line feeds", "\n"],
      ["carriage returns", "\r"],
      ["near-miss delimiter lines", `\n--${boundary.slice(0, -1)}`],
      ["CRLF then dashes", `\r\n${"-".repeat(71)}`],
    ];

    it.each(fills)("%s", (_, unit) => {
      const head = encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\n\r\n`);
      const bytes = [...head, ...encode(unit.repeat(Math.ceil(size / unit.length))).subarray(0, size)];
      let reads = 0;
      const counted = new Proxy(bytes, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      multipartShapeProblem(counted as unknown as Uint8Array, boundary);
      expect(reads).toBeLessThanOrEqual(3 * bytes.length);
    });
  });
});

describe("accepts each browser's upload as its source writes it: its Content-Type and a body of one file part (P4-17 Condition 1)", () => {
  // The formats, transcribed from the Blink, WebKit and Gecko sources with file and line, are in test/support/browsers.ts.
  const photo = encode("\xff\xd8\xff--\r\n----WebKit\r\n----gecko\r\n\r\n--");
  const upload = (boundary: string): Uint8Array => browserMultipart(boundary, [{ name: "file", filename: "photo.jpg", type: "image/jpeg", content: photo }]);

  const accepted = (boundary: string): void => {
    expect(multipartBoundary(browserContentType(boundary)), boundary).toBe(boundary);
    expect(multipartShapeProblem(upload(boundary), boundary), boundary).toBeNull();
  };

  it.each(BROWSER_BOUNDARIES)("%s: 200 boundaries drawn as the engine draws them", (_, draw) => {
    for (let i = 0; i < 200; i += 1) accepted(draw());
  });

  it("Chromium and Safari: ----WebKitFormBoundary plus 16 characters of the engines' map, 38 in all, its ends and wrap-around included", () => {
    // Blink maps each random byte with `c & 0x3F`: the map's first and last entries, and bytes past 63 wrap.
    const blink = blinkBoundary(new Uint8Array([0, 25, 26, 51, 52, 61, 62, 63, 64, 255, 128, 191, 1, 2, 3, 4]));
    expect(blink).toBe("----WebKitFormBoundaryAZaz09ABABABBCDE");
    // WebKit takes four 6-bit indexes from each of four 32-bit numbers, high bits first.
    const webkit = webKitBoundary(new Uint32Array([0x00193334, 0xffffffff, 0x3f3e3d3c, 0x01020304]));
    expect(webkit).toBe("----WebKitFormBoundaryAZz0BBBBBA98BCDE");
    for (const boundary of [blink, webkit]) {
      expect(boundary).toHaveLength(38);
      accepted(boundary);
    }
  });

  it("Firefox: ----geckoformboundary plus two 64-bit values in unpadded lower-case hex, 23 to 53 characters, the shortest and the longest included", () => {
    const shortest = geckoBoundary(0n, 0n);
    const longest = geckoBoundary(2n ** 64n - 1n, 2n ** 64n - 1n);
    const sample = geckoBoundary(0x1a2b3c4d5e6f7081n, 0xdeadbeefn);
    expect(shortest).toBe("----geckoformboundary00");
    expect(longest).toBe(`----geckoformboundary${"f".repeat(32)}`);
    expect(sample).toBe("----geckoformboundary1a2b3c4d5e6f7081deadbeef");
    expect([shortest.length, longest.length]).toEqual([23, 53]);
    for (const boundary of [shortest, longest, sample]) accepted(boundary);
  });

  it("with the fields a form may add around the file, up to MAX_PARTS parts in all", () => {
    for (const [, draw] of BROWSER_BOUNDARIES) {
      const boundary = draw();
      const fields = Array.from({ length: MAX_PARTS - 1 }, (_, i) => ({ name: `field${i}`, value: `value ${i}` }));
      const body = browserMultipart(boundary, [...fields, { name: "file", filename: "photo.jpg", type: "image/jpeg", content: photo }]);
      expect(multipartShapeProblem(body, boundary), boundary).toBeNull();
    }
  });
});
