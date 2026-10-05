import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { FlushResult } from "../lib/autosave.ts";
import { matchRoute, type Route } from "../lib/route.ts";
import { settleLeaving } from "./use-site.ts";

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
  /** The text that stops "Sign out" for what the flush answered (it ends with PRESS_AGAIN). */
  message: (result: false | "dropped") => string;
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
export function useLeaveGuard(flush: () => Promise<FlushResult>, stopped: (result: false | "dropped") => void, message: (result: false | "dropped") => string): void {
  const latest = useRef({ stopped, message });
  useEffect(() => {
    latest.current = { stopped, message };
  });
  useEffect(() => {
    setLeaveGuard({ flush, stopped: (result) => latest.current.stopped(result), message: (result) => latest.current.message(result) });
    return () => setLeaveGuard(null);
  }, [flush]);
}

// "Sign out" stops AT MOST ONCE (on every page and path): a press that finds something unsaved says so and stays; the next press signs out,
// and so does a press made while an earlier one is still waiting (a save that never answers must not trap the owner).
let stopShown = false;
let presses = 0;
let waiting = false;

/** A new page is on screen: its first stop is its own to say. */
export function resetSignOutStop(): void {
  stopShown = false;
}

/**
 * Whether the session may end now. The saves a page started as it closed finish first (settleLeaving), then the page on screen saves
 * what it holds. Nothing can be saved after the logout, so anything left unsaved stops the press once: `onStopped` gets the text (the
 * existing wording for what went wrong, then PRESS_AGAIN) and the next press goes on without saving. A press while the first is
 * still waiting goes on at once; the first press then ends without a word (it was overtaken). Pages with nothing to save pass at once.
 */
export async function mayEndSession(onStopped: (message: string) => void): Promise<boolean> {
  if (stopShown || waiting) {
    presses += 1;
    return true;
  }
  const mine = ++presses;
  waiting = true;
  try {
    const message = await firstStop();
    if (mine !== presses) return false;
    if (message === null) return true;
    stopShown = true;
    onStopped(message);
    return false;
  } finally {
    if (mine === presses) waiting = false;
  }
}

/** The text that stops this press (and, for a dropped wording change, the page's own notice is shown too), or null when all is saved. */
async function firstStop(): Promise<string | null> {
  const leftBehind = await settleLeaving();
  if (leftBehind !== null) return leftBehind;
  const guard = leaveGuard;
  if (guard === null) return null;
  const result = await guard.flush();
  if (result === true) return null;
  // A failed save is said by the message alone (the page would say the same words again); a drop also focuses the page's own notice.
  if (result === "dropped") guard.stopped(result);
  return guard.message(result);
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
