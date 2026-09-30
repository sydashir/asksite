import { useEffect, useState, type MouseEvent } from "react";
import { matchRoute, type Route } from "../lib/route.ts";

const CHANGE = "asksite:navigate";

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new Event(CHANGE));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => matchRoute(location.pathname));
  useEffect(() => {
    const update = () => setRoute(matchRoute(location.pathname));
    window.addEventListener("popstate", update);
    window.addEventListener(CHANGE, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(CHANGE, update);
    };
  }, []);
  return route;
}

const plainClick = (event: MouseEvent<HTMLAnchorElement>): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** For <a href> links inside the app: a plain left click navigates without reloading the page. */
export function onLinkClick(event: MouseEvent<HTMLAnchorElement>): void {
  if (!plainClick(event)) return;
  event.preventDefault();
  const url = new URL(event.currentTarget.href);
  navigate(`${url.pathname}${url.hash}`);
}

/**
 * For links away from a page that holds a draft: save first, then go; if saving fails, stay and call
 * `onUnsaved`, so nothing typed is lost (decision 37).
 */
export function linkAfter(save: () => Promise<boolean>, onUnsaved: () => void) {
  return (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!plainClick(event)) return;
    event.preventDefault();
    const url = new URL(event.currentTarget.href);
    void save().then((saved) => (saved ? navigate(`${url.pathname}${url.hash}`) : onUnsaved()));
  };
}
