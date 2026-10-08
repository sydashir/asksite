// A cheap look at a multipart body before formData() parses it (P4-15 d, and the P4-15 review's I1 and I2).
// workerd's parser (src/workerd/api/form-data.c++) walks every part and every header byte before it answers, and
// its delimiter search (std::search) costs the searched length times the boundary's. An upload is one file part
// (§4.4, field `file`) with a short header, so the look refuses what only makes that parse slow, and it finds the
// parts where the parser finds them, in one pass whose cost grows with the body alone:
// - the boundary is read only from the Content-Type form browsers send, so it is the parser's boundary, and it is
//   at most 70 characters (RFC 2046 5.1.1);
// - the body must start with its first delimiter (no preamble), so the parser's first search ends at once;
// - a later delimiter counts only right after a line feed, as in the parser, and a close does not end the count;
// - at most MAX_PARTS parts, each with headers that end within MAX_PART_HEADER_BYTES.
// Measured through the upload route in workerd (2026-09-27, 10 MB bodies): the shapes the old look let through or
// made slow (a decoy or escaped boundary, a mid-line close, dashes with a 70-character dash boundary, a dash
// preamble, near-miss delimiter lines) took 2.1-5.2 s; now each answers in 206-419 ms, against 261-360 ms for one
// plain 10 MB part. The look reads each body byte at most about twice (counted, test/worker/multipart.test.ts).

/** An upload is one file part; a few more fields fit, thousands are no upload. */
export const MAX_PARTS = 4;

/** A part's headers (a Content-Disposition naming the field and the file, a Content-Type) are a few hundred bytes. */
export const MAX_PART_HEADER_BYTES = 4 * 1024;

export type MultipartShapeProblem = "no_leading_delimiter" | "too_many_parts" | "part_header_too_long";

/**
 * The Content-Type form browsers send: `multipart/form-data; boundary=` and 1 to 70 of RFC 2046's bcharsnospace,
 * bare, with no other parameter. From it every MIME parser, workerd's included, reads the same boundary; from a
 * quoted value or more parameters, a looser read can find another one than the parser does.
 */
const FORM_DATA_TYPE = /^multipart\/form-data;[\t ]*boundary=([0-9A-Za-z'()+_,\-./:=?]{1,70})$/i;

/** The boundary of a Content-Type in the form browsers send, or null for any other Content-Type. */
export function multipartBoundary(contentType: string): string | null {
  return FORM_DATA_TYPE.exec(contentType)?.[1] ?? null;
}

const encoder = new TextEncoder();
const CR = 0x0d;
const LF = 0x0a;

function startsAt(bytes: Uint8Array, at: number, needle: Uint8Array): boolean {
  if (at + needle.length > bytes.length) return false;
  for (let i = 0; i < needle.length; i += 1) if (bytes[at + i] !== needle[i]) return false;
  return true;
}

/**
 * Where the next delimiter at or after `from` starts: a `--boundary` right after a line feed, as the parser finds
 * it; or -1. Each byte is read once, plus the bytes that match the delimiter after a line feed, which hold no line
 * feed (the boundary has none), so the next line feed lies beyond them: the pass is linear in the body.
 */
function nextDelimiter(body: Uint8Array, delimiter: Uint8Array, from: number): number {
  const end = body.length;
  for (let at = from; at < end; at += 1) {
    if (body[at] === LF && startsAt(body, at + 1, delimiter)) return at + 1;
  }
  return -1;
}

/** Where a part's headers start: after the LF or CRLF that ends its delimiter line; -1 when neither follows ("--" closes the body). */
function headersStart(body: Uint8Array, at: number): number {
  if (body[at] === LF) return at + 1;
  if (body[at] === CR && body[at + 1] === LF) return at + 2;
  return -1;
}

/**
 * Whether the headers starting at `from` end within MAX_PART_HEADER_BYTES, where the parser's /\r?\n\r?\n/ first
 * matches: the first line feed followed by a line feed, with or without a carriage return between them.
 */
function headersEndWithin(body: Uint8Array, from: number): boolean {
  const end = Math.min(body.length, from + MAX_PART_HEADER_BYTES + 2);
  for (let at = from; at < end; at += 1) {
    if (body[at] !== LF) continue;
    if (body[at + 1] === LF || (body[at + 1] === CR && body[at + 2] === LF)) {
      const blankLine = at > from && body[at - 1] === CR ? at - 1 : at;
      return blankLine - from <= MAX_PART_HEADER_BYTES;
    }
  }
  return false;
}

/**
 * Whether the body does not start with its first delimiter, has more than MAX_PARTS parts, or has a part whose
 * headers do not end (a blank line) within MAX_PART_HEADER_BYTES. A part starts at every delimiter followed by a
 * line end, after a close too, so the count is never below the parser's. Null for a body shaped like an upload.
 */
export function multipartShapeProblem(body: Uint8Array, boundary: string): MultipartShapeProblem | null {
  const delimiter = encoder.encode(`--${boundary}`);
  // The parser takes the first `--boundary` anywhere as the first delimiter; at the body's start, it looks no further.
  if (!startsAt(body, 0, delimiter)) return "no_leading_delimiter";
  let parts = 0;
  for (let at = 0; at !== -1; at = nextDelimiter(body, delimiter, at + delimiter.length)) {
    const headers = headersStart(body, at + delimiter.length);
    if (headers === -1) continue;
    parts += 1;
    if (parts > MAX_PARTS) return "too_many_parts";
    if (!headersEndWithin(body, headers)) return "part_header_too_long";
  }
  return null;
}
