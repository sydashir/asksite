/** Shown only in the review frame, never stored: in-page links would navigate the srcdoc frame to the admin's own address. */
export const PREVIEW_ONLY_STYLE = "<style>a[href]{pointer-events:none;cursor:default}</style>";

/** The stored page with its links turned off, for the preview frame. The stored bytes themselves are never changed. */
export function withLinksOff(html: string): string {
  const head = html.indexOf("</head>");
  return head === -1 ? `${PREVIEW_ONLY_STYLE}${html}` : `${html.slice(0, head)}${PREVIEW_ONLY_STYLE}${html.slice(head)}`;
}
