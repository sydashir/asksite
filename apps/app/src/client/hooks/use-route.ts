import { useEffect, useRef, useState, type MouseEvent } from "react";
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

/** What a page that holds a draft gives the app: how to save it, and how to tell the owner when a leave was stopped (false: not saved; "dropped": a wording change was not applied). */
export interface LeaveGuard {
  flush: () => Promise<FlushResult>;
  stopped: (result: false | "dropped") => void;
}

/** Set by a page that holds an unsaved draft: every plain link click (onLinkClick) and Sign out wait for it. */
let leaveGuard: LeaveGuard | null = null;
export function setLeaveGuard(guard: LeaveGuard | null): void {
  leaveGuard = guard;
}

/**
 * Registers the page's guard while it is mounted. `stopped` may change on every render; the guard always calls the newest.
 * Every page that holds a draft (the editor, the questionnaire, Publish) uses this.
 */
export function useLeaveGuard(flush: () => Promise<FlushResult>, stopped: (result: false | "dropped") => void): void {
  const latest = useRef(stopped);
  useEffect(() => {
    latest.current = stopped;
  });
  useEffect(() => {
    setLeaveGuard({ flush, stopped: (result) => latest.current(result) });
    return () => setLeaveGuard(null);
  }, [flush]);
}

/**
 * Whether the session may end now: the page saves what it holds first, and "Sign out" goes on only when everything is saved. Unlike a
 * link (which still leaves after an ordinary failed save, because the page's unmount sends it later), nothing can be saved after the
 * logout, so a failed save stays and says so; a dropped wording change stops it once (the next press goes on). Pages with nothing to save pass at once.
 */
export async function mayEndSession(): Promise<boolean> {
  const guard = leaveGuard;
  if (guard === null) return true;
  const result = await guard.flush();
  if (result === true) return true;
  guard.stopped(result);
  return false;
}

/** For <a href> links inside the app: a plain left click navigates without reloading the page (after the page's leave guard, if it set one). */
export function onLinkClick(event: MouseEvent<HTMLAnchorElement>): void {
  if (!plainClick(event)) return;
  event.preventDefault();
  const url = new URL(event.currentTarget.href);
  const go = () => navigate(`${url.pathname}${url.hash}`);
  const guard = leaveGuard;
  if (guard === null) go();
  else
    void guard.flush().then((result) => {
      // Only a dropped wording change stops a link; any other failed save still leaves (decision 37).
      if (result === "dropped") guard.stopped(result);
      else go();
    });
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
