import { useEffect, useState, type MouseEvent } from "react";
import type { FlushResult } from "../lib/autosave.ts";
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

/** Set by a page that holds an unsaved draft: every plain link click (onLinkClick) waits for it, and goes only when it answers true. */
let leaveGuard: (() => Promise<boolean>) | null = null;
export function setLeaveGuard(guard: (() => Promise<boolean>) | null): void {
  leaveGuard = guard;
}

/** For <a href> links inside the app: a plain left click navigates without reloading the page (after the page's leave guard, if it set one). */
export function onLinkClick(event: MouseEvent<HTMLAnchorElement>): void {
  if (!plainClick(event)) return;
  event.preventDefault();
  const url = new URL(event.currentTarget.href);
  const go = () => navigate(`${url.pathname}${url.hash}`);
  if (leaveGuard === null) go();
  else void leaveGuard().then((mayLeave) => (mayLeave ? go() : undefined));
}

/**
 * For links away from a page that holds a draft: save first, then go; if saving fails, stay and call
 * `onUnsaved`, so nothing typed is lost (decision 37). A save that dropped the owner's wording ("dropped") stops the link once too.
 */
export function linkAfter(save: () => Promise<FlushResult>, onUnsaved: (result: false | "dropped") => void) {
  return (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!plainClick(event)) return;
    event.preventDefault();
    const url = new URL(event.currentTarget.href);
    void save().then((saved) => (saved === true ? navigate(`${url.pathname}${url.hash}`) : onUnsaved(saved)));
  };
}
