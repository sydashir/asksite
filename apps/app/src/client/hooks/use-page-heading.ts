import { useEffect, useRef } from "react";

/**
 * Sets the tab title and moves focus to the page heading when the page (or step) changes, so
 * keyboard and screen-reader users start at the top of the new content (§9.2).
 */
export function usePageHeading<T extends HTMLElement>(title: string, product = "Your website") {
  const ref = useRef<T>(null);
  useEffect(() => {
    document.title = `${title} | ${product}`;
    ref.current?.focus();
  }, [title, product]);
  return ref;
}
