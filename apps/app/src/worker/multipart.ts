// A cheap look at a multipart body before formData() parses it (P4-15 d). The parser walks every part and every
// header byte before it answers, and its time grows with them: in workerd (measured 2026-09-27), 10 MB of about
// 140,000 empty parts parsed in 7.5-8 times a plain 10 MB upload's time, and one part with a 10 MB file name in
// 11-12.5 times, while a boundary of 70 or 2,000 characters with near-miss matches cost no more than the plain
// upload. An upload is one file part (§4.4, field `file`) with a short header, so a body with more parts than
// MAX_PARTS, or a part whose headers do not end within MAX_PART_HEADER_BYTES, is refused first. Only the
// delimiters and the bytes right after each are looked at, so the look stays short whatever the body holds.

/** An upload is one file part; a few more fields fit, thousands are no upload. */
export const MAX_PARTS = 4;

/** A part's headers (a Content-Disposition naming the field and the file, a Content-Type) are a few hundred bytes. */
export const MAX_PART_HEADER_BYTES = 4 * 1024;

export type MultipartShapeProblem = "too_many_parts" | "part_header_too_long";

/** The boundary parameter of a multipart Content-Type, bare or quoted, or null when there is none. */
export function multipartBoundary(contentType: string): string | null {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2] ?? null;
}

const encoder = new TextEncoder();
const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;
const BLANK_LINE = new Uint8Array([CR, LF, CR, LF]);

function matchesAt(bytes: Uint8Array, at: number, needle: Uint8Array): boolean {
  if (at + needle.length > bytes.length) return false;
  for (let i = 0; i < needle.length; i += 1) if (bytes[at + i] !== needle[i]) return false;
  return true;
}

/** Where `needle` first starts within bytes[from, to), or -1. The native indexOf skips to each candidate first byte. */
function indexOfBytes(bytes: Uint8Array, needle: Uint8Array, from: number, to: number): number {
  const first = needle[0]!;
  const last = Math.min(to, bytes.length) - needle.length;
  for (let at = bytes.indexOf(first, from); at !== -1 && at <= last; at = bytes.indexOf(first, at + 1)) {
    if (matchesAt(bytes, at, needle)) return at;
  }
  return -1;
}

/**
 * Whether the body has more than MAX_PARTS parts, or a part whose headers do not end (a blank line) within
 * MAX_PART_HEADER_BYTES of its delimiter line. A body of many parts is refused at the part that is one too many,
 * and a huge header at the limit. Null for a body shaped like an upload, or with no delimiter at all (formData()
 * refuses that one itself).
 */
export function multipartShapeProblem(body: Uint8Array, boundary: string): MultipartShapeProblem | null {
  const delimiter = encoder.encode(`--${boundary}`);
  let parts = 0;
  for (let at = indexOfBytes(body, delimiter, 0, body.length); at !== -1; at = indexOfBytes(body, delimiter, at + delimiter.length, body.length)) {
    const after = at + delimiter.length;
    // "--" right after the boundary closes the body: no part follows.
    if (body[after] === DASH && body[after + 1] === DASH) break;
    parts += 1;
    if (parts > MAX_PARTS) return "too_many_parts";
    const headers = body[after] === CR && body[after + 1] === LF ? after + 2 : after;
    if (indexOfBytes(body, BLANK_LINE, headers, headers + MAX_PART_HEADER_BYTES + BLANK_LINE.length) === -1) return "part_header_too_long";
  }
  return null;
}
