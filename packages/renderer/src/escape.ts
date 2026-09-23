// Text nodes only need &, < and > escaped. Attribute values (always double-quoted in our
// templates) also need both quote characters escaped.
const TEXT_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const ATTR_ESCAPES: Record<string, string> = { ...TEXT_ESCAPES, '"': "&quot;", "'": "&#39;" };

export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (c) => TEXT_ESCAPES[c] ?? c);
}

export function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ATTR_ESCAPES[c] ?? c);
}
