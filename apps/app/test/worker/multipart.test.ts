import { describe, expect, it } from "vitest";
import { MAX_PART_HEADER_BYTES, MAX_PARTS, multipartBoundary, multipartShapeProblem } from "../../src/worker/multipart.ts";

// A cheap look at a multipart body before formData() parses it (P4-15 d): more parts than an upload
// has, or a part whose headers run on for kilobytes, are refused before the parser spends seconds on them.

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const BOUNDARY = "----WebKitFormBoundary7MA4YWxkTrZu0gW";

/** A multipart body of the given parts (each already holding its headers, a blank line and its content). */
function body(parts: string[], boundary = BOUNDARY): Uint8Array {
  return encode(parts.map((part) => `--${boundary}\r\n${part}\r\n`).join("") + `--${boundary}--\r\n`);
}

const filePart = (content: string, filename = "photo.jpg"): string => `Content-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n${content}`;
const fieldPart = (name: string, value: string): string => `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}`;

describe("multipartBoundary", () => {
  it("reads the boundary parameter, bare or quoted, whatever its case", () => {
    expect(multipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
    expect(multipartBoundary('multipart/form-data; boundary="a b:c"')).toBe("a b:c");
    expect(multipartBoundary("multipart/form-data;BOUNDARY=abc; charset=utf-8")).toBe("abc");
  });

  it("is null without one (formData() refuses such a body itself)", () => {
    expect(multipartBoundary("multipart/form-data")).toBeNull();
    expect(multipartBoundary("multipart/form-data;")).toBeNull();
    expect(multipartBoundary("application/json")).toBeNull();
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

  it("leaves a body with no delimiter at all, or an empty one, to formData()", () => {
    expect(multipartShapeProblem(encode("not multipart at all"), BOUNDARY)).toBeNull();
    expect(multipartShapeProblem(new Uint8Array(), BOUNDARY)).toBeNull();
  });
});
