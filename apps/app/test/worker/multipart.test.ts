import { describe, expect, it } from "vitest";
import { MAX_PART_HEADER_BYTES, MAX_PARTS, multipartBoundary, multipartShapeProblem } from "../../src/worker/multipart.ts";

// A cheap look at a multipart body before formData() parses it (P4-15 d): more parts than an upload
// has, or a part whose headers run on for kilobytes, are refused before the parser spends seconds on them.
// The look must find the parts where workerd's parser finds them (P4-15 review I1, I2): the boundary is read
// from the one Content-Type form browsers send, and a delimiter counts only at the body's start or after a
// line feed, as in the parser.

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const BOUNDARY = "----WebKitFormBoundary7MA4YWxkTrZu0gW";

/** A multipart body of the given parts (each already holding its headers, a blank line and its content). */
function body(parts: string[], boundary = BOUNDARY): Uint8Array {
  return encode(parts.map((part) => `--${boundary}\r\n${part}\r\n`).join("") + `--${boundary}--\r\n`);
}

const filePart = (content: string, filename = "photo.jpg"): string => `Content-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n${content}`;
const fieldPart = (name: string, value: string): string => `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}`;
const joined = (...chunks: Uint8Array[]): Uint8Array => new Uint8Array(chunks.flatMap((chunk) => [...chunk]));

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
    expect(multipartShapeProblem(body([filePart("\xff\xd8\xff--------\r\n\r\n----WebKit")]), BOUNDARY)).toBeNull();
    const fields = Array.from({ length: MAX_PARTS - 1 }, (_, i) => fieldPart(`field${i}`, "x"));
    expect(multipartShapeProblem(body([...fields, filePart("data")]), BOUNDARY)).toBeNull();
  });

  it(`refuses more than MAX_PARTS (${MAX_PARTS}) parts, without reading past the part that is one too many`, () => {
    const parts = Array.from({ length: MAX_PARTS + 1 }, (_, i) => fieldPart(`field${i}`, "x"));
    expect(multipartShapeProblem(body(parts), BOUNDARY)).toBe("too_many_parts");
    // The closing delimiter is not a part.
    expect(multipartShapeProblem(body(parts.slice(0, MAX_PARTS)), BOUNDARY)).toBeNull();
  });

  it(`refuses a part whose headers do not end within MAX_PART_HEADER_BYTES (${MAX_PART_HEADER_BYTES})`, () => {
    // The headers end where the blank line (CRLF CRLF) starts, so a part whose header text is exactly the limit passes.
    const headerOf = (part: string): number => part.indexOf("\r\n\r\n");
    const fits = filePart("data", "a".repeat(MAX_PART_HEADER_BYTES - headerOf(filePart("data", ""))));
    expect(headerOf(fits)).toBe(MAX_PART_HEADER_BYTES);
    expect(multipartShapeProblem(body([fits]), BOUNDARY)).toBeNull();
    const over = filePart("data", "a".repeat(MAX_PART_HEADER_BYTES - headerOf(filePart("data", "")) + 1));
    expect(headerOf(over)).toBe(MAX_PART_HEADER_BYTES + 1);
    expect(multipartShapeProblem(body([over]), BOUNDARY)).toBe("part_header_too_long");
    // A part with no blank line at all (a header that is the whole body).
    expect(multipartShapeProblem(encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${"a".repeat(2 * MAX_PART_HEADER_BYTES)}`), BOUNDARY)).toBe("part_header_too_long");
  });

  it("refuses a body that does not start with its first delimiter: no delimiter, an empty body, or a preamble first", () => {
    expect(multipartShapeProblem(encode("not multipart at all"), BOUNDARY)).toBe("no_leading_delimiter");
    expect(multipartShapeProblem(new Uint8Array(), BOUNDARY)).toBe("no_leading_delimiter");
    // RFC 2046 5.1.1 allows a preamble but says it "should generally be left blank"; no browser sends one, and the
    // parser's search for the first delimiter across it costs the preamble's length times the boundary's.
    expect(multipartShapeProblem(joined(encode("preamble\r\n"), body([filePart("data")])), BOUNDARY)).toBe("no_leading_delimiter");
  });

  it("counts a delimiter only at a line start, as the parser does: a --boundary-- inside a line does not end the body", () => {
    const fields = Array.from({ length: MAX_PARTS }, (_, i) => fieldPart(`field${i}`, "x"));
    expect(multipartShapeProblem(body([fieldPart("note", `xx--${BOUNDARY}--yy`), ...fields]), BOUNDARY)).toBe("too_many_parts");
    // Nor does a --boundary inside a line start a part.
    const inLine = Array.from({ length: MAX_PARTS + 1 }, () => `x--${BOUNDARY}\r\n`).join("");
    expect(multipartShapeProblem(body([filePart(inLine)]), BOUNDARY)).toBeNull();
  });

  it("does not stop at a close delimiter: every delimiter line after it counts too", () => {
    // Browsers send nothing after the close. Counting every delimiter line keeps the count at or above the
    // parser's parts, whatever it makes of the lines around a close.
    const after = Array.from({ length: MAX_PARTS }, (_, i) => `--${BOUNDARY}\r\n${fieldPart(`late${i}`, "x")}\r\n`).join("");
    expect(multipartShapeProblem(joined(body([filePart("data")]), encode(after)), BOUNDARY)).toBe("too_many_parts");
  });

  it("reads bare LF line ends as the parser does: a delimiter after a LF counts, and headers may end with LF LF", () => {
    const lf = (parts: string[]): Uint8Array => encode(parts.map((part) => `--${BOUNDARY}\n${part}\n`).join("") + `--${BOUNDARY}--\n`);
    expect(multipartShapeProblem(lf([`Content-Disposition: form-data; name="file"; filename="a.jpg"\nContent-Type: image/jpeg\n\ndata`]), BOUNDARY)).toBeNull();
    const fields = Array.from({ length: MAX_PARTS + 1 }, (_, i) => `Content-Disposition: form-data; name="field${i}"\n\nx`);
    expect(multipartShapeProblem(lf(fields), BOUNDARY)).toBe("too_many_parts");
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
