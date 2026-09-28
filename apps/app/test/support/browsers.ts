// How each browser engine encodes a multipart/form-data upload, transcribed from its source (P4-17 Condition 1).
// Every line below was read on 2026-09-28 from the project's main branch on GitHub, at the commit that last
// touched the file (raw.githubusercontent.com; commit from api.github.com/repos/<project>/commits?path=).
//
// Blink (Chromium):
// - third_party/blink/renderer/platform/network/form_data_encoder.cc @ 23b8b28832e9: GenerateUniqueBoundaryString
//   :121-160 is "----WebKitFormBoundary" (:139) plus 16 random bytes (:140, :151-157), each mapped with `c & 0x3F`
//   into the 64-entry map at :131-137 (A-Z, a-z, 0-9, then A and B again). AddBoundaryToMultiPartHeader :174-187
//   writes "--", the boundary, "--" for the last one, then "\r\n". BeginMultiPartHeader :162-172 writes
//   `Content-Disposition: form-data; name="<name>"`, AddFilenameToMultiPartHeader :189-224 `; filename="<name>"`,
//   AddContentTypeToMultiPartHeader :226-230 "\r\nContent-Type: <type>", FinishMultiPartHeader :232-234 "\r\n\r\n".
// - third_party/blink/renderer/core/html/forms/form_data.cc @ 2682016f0b2f: EncodeMultiPartFormData :298-362 writes,
//   per entry, that header (a file's with its filename and type, "application/octet-stream" when it has none,
//   :310-335), the content (:341-353), then "\r\n" (:354); after the last entry the closing delimiter (:357-360).
// - third_party/blink/renderer/platform/network/encoded_form_data.cc @ 23b8b28832e9: FormatContentTypeWithBoundary
//   :221-223 is "multipart/form-data; boundary=" plus the boundary. fetch() sends it (core/fetch/request.cc
//   @ 9c39ba4a98de :273-276) and so does XMLHttpRequest (core/xmlhttprequest/xml_http_request.cc @ 23b8b28832e9 :901-906).
//
// WebKit (Safari):
// - Source/WebCore/platform/network/FormDataBuilder.cpp @ f2ca04538ea6: generateUniqueBoundaryString :119-154 is
//   "----WebKitFormBoundary" (:142) plus 16 characters (:144-151): four random 32-bit numbers, each giving four
//   6-bit indexes into the same 64-entry map (:130-139). addBoundaryToMultiPartHeader :167-176, beginMultiPartHeader
//   :156-165, addFilenameToMultiPartHeader :178-183, addContentTypeToMultiPartHeader :185-190 and
//   finishMultiPartHeader :192-195 write the same bytes as Blink's.
// - Source/WebCore/platform/network/FormData.cpp @ 29a96fa5509b: appendMultiPartKeyValuePairItems :261-290 writes,
//   per item, the header (a file's through appendMultiPartFileValue :228-250), the content, then "\r\n" (:283-284);
//   after the last item the closing delimiter (:287-289).
// - Source/WebCore/Modules/fetch/FetchBody.cpp @ 57d9da4c518b :69: "multipart/form-data; boundary=" plus the boundary.
//
// Gecko (Firefox):
// - dom/html/HTMLFormSubmission.cpp @ 12ec1ec1e2be: FSMultipartFormData's boundary :362-364 is "----geckoformboundary"
//   plus two RandomUint64OrDie() values, each appended in radix 16. A file part (AddDataChunk :513-541) is
//   "--<boundary>" CRLF, `Content-Disposition: form-data; name="<name>"; filename="<name>"` CRLF, "Content-Type: <type>"
//   CRLF CRLF, the stream, CRLF (:522-526, :540); a text part is the same without the filename and type (:395-398);
//   the body ends with "--<boundary>--" CRLF (:374). GetEncodedSubmission :543-560 sends GetContentType's value.
// - dom/html/HTMLFormSubmission.h @ 12ec1ec1e2be :242-244: GetContentType is "multipart/form-data; boundary=" plus the
//   boundary. dom/base/FormData.cpp @ c8de248a9422 :358-371: fetch() and XMLHttpRequest take the body and the
//   Content-Type from the same FSMultipartFormData.
// - The radix-16 append: xpcom/string/nsTSubstring.h @ bd8b71b80f29 :846-853 sends radix 16 to AppendIntHex(uint64_t),
//   xpcom/string/nsTSubstring.cpp @ bd8b71b80f29 :1239-1245 calls PrintfTarget::appendIntHex(uint64_t), and
//   mozglue/misc/Printf.cpp @ 06f7ead7627f :226-228 converts with the lower-case digits of :67 through cvt_ll
//   :264-294, with no width or precision (so no padding; zero prints as "0"). Each value is 1 to 16 hex digits, and
//   the boundary 23 to 53 characters. CRLF is "\015\012": xpcom/base/nsCRTGlue.h @ 6149f4929967 :128.

/** The 64 characters Blink and WebKit pick a boundary's 16 random characters from, in the order of their maps. */
const WEBKIT_BOUNDARY_MAP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789AB";

const WEBKIT_PREFIX = "----WebKitFormBoundary";
const GECKO_PREFIX = "----geckoformboundary";

/** Blink's boundary (form_data_encoder.cc :139-157): the prefix plus one map entry per random byte, `c & 0x3F`. */
export function blinkBoundary(randomBytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
  if (randomBytes.length !== 16) throw new Error("Blink draws 16 random bytes");
  return WEBKIT_PREFIX + Array.from(randomBytes, (c) => WEBKIT_BOUNDARY_MAP[c & 0x3f]).join("");
}

/** WebKit's boundary (FormDataBuilder.cpp :142-151): the prefix plus four map entries per random 32-bit number. */
export function webKitBoundary(randomness: Uint32Array = crypto.getRandomValues(new Uint32Array(4))): string {
  if (randomness.length !== 4) throw new Error("WebKit draws 4 random 32-bit numbers");
  let boundary = WEBKIT_PREFIX;
  for (const r of randomness) {
    boundary += WEBKIT_BOUNDARY_MAP[(r >>> 24) & 0x3f]! + WEBKIT_BOUNDARY_MAP[(r >>> 16) & 0x3f]! + WEBKIT_BOUNDARY_MAP[(r >>> 8) & 0x3f]! + WEBKIT_BOUNDARY_MAP[r & 0x3f]!;
  }
  return boundary;
}

/** A random 64-bit value, as Gecko's RandomUint64OrDie() gives. */
export const randomUint64 = (): bigint => crypto.getRandomValues(new BigUint64Array(1))[0]!;

/** Gecko's boundary (HTMLFormSubmission.cpp :362-364): the prefix plus two 64-bit values in unpadded lower-case hex. */
export function geckoBoundary(first: bigint = randomUint64(), second: bigint = randomUint64()): string {
  return GECKO_PREFIX + first.toString(16) + second.toString(16);
}

/** The Content-Type all three engines send (encoded_form_data.cc :222, FetchBody.cpp :69, HTMLFormSubmission.h :243). */
export const browserContentType = (boundary: string): string => `multipart/form-data; boundary=${boundary}`;

export type BrowserPart = { name: string; value: string } | { name: string; filename: string; type: string; content: Uint8Array };

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * The body all three engines write for these parts (form_data.cc :298-362, FormData.cpp :261-290,
 * HTMLFormSubmission.cpp :374-398 and :513-541): for each part its delimiter line, its Content-Disposition (a
 * file's with its filename and Content-Type), a blank line, its content and CRLF; then the closing delimiter line.
 */
export function browserMultipart(boundary: string, parts: BrowserPart[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if ("content" in part) {
      chunks.push(encode(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n`), part.content);
    } else {
      chunks.push(encode(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}`));
    }
    chunks.push(encode("\r\n"));
  }
  chunks.push(encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Each engine, with a boundary drawn as its source draws one. */
export const BROWSER_BOUNDARIES: Array<[engine: string, boundary: () => string]> = [
  ["Chromium (Blink)", () => blinkBoundary()],
  ["Safari (WebKit)", () => webKitBoundary()],
  ["Firefox (Gecko)", () => geckoBoundary()],
];
