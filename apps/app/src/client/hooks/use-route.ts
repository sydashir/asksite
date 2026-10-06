import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { FlushResult } from "../lib/autosave.ts";
import { matchRoute, type Route } from "../lib/route.ts";
import { PRESS_AGAIN, SAVING } from "../lib/save-message.ts";
import { sameIncident, type StopCause } from "../lib/stop-cause.ts";
import { hasClosingSave, settleLeaving, type SiteState } from "./use-site.ts";

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

// SIGN OUT, in one place. The rules:
// 1. EVERY press first saves the page on screen (its flush) and settles the saves closed editors left (settleLeaving). No state can let a
//    press skip that, so nothing the owner typed is lost, and nothing is remembered between presses that could make it skip.
// 2. A second press within SIGN_OUT_GRACE_MS of a press that is still waiting, or whose stop is on screen, is IGNORED (a double click).
//    A press after the grace while a save is still in flight signs out: a save that never answers must not trap the owner.
// 3. After the save, the CAUSES left are collected, each identified by (site, kind) plus the saver or drop it came from (StopCause).
// 4. A cause the owner was not told yet stops the press ONCE (the existing text for it, then PRESS_AGAIN) and joins the TOLD set.
//    When every cause is already told, the press signs out. A closing drop a stop shows is marked stopped in place, so the site's next editor
//    does not stop a leave again for it.
// 5. A resolved cause leaves the told set (the next press builds it from what is left), so one that comes back stops once more.
//    The alert goes when the causes it names are resolved. Nothing expires by time, and there is no page-wide flag.
// 6. "Saving…" is said only while a save is actually pending. A new page on screen starts again (resetSignOutStop).

/** What a page that holds a draft gives the app: how to save it, and how to tell the owner when a leave was stopped (false: not saved; "dropped": a wording change was not applied). */
export interface LeaveGuard {
  flush: () => Promise<FlushResult>;
  /** Whether a flush would send a save now (the page holds something unsent). */
  saving: () => boolean;
  stopped: (result: false | "dropped") => void;
  /** Why a flush that answered `result` did not end clean. */
  cause: (result: false | "dropped") => StopCause | null;
}

/** Set by a page that holds an unsaved draft: every plain link click (onLinkClick) and Sign out wait for it. */
let leaveGuard: LeaveGuard | null = null;
export function setLeaveGuard(guard: LeaveGuard | null): void {
  leaveGuard = guard;
}

/**
 * Registers the page's guard while it is mounted. `stopped` may change on every render; the guard always calls the newest.
 * Every page that holds a draft (the editor, the questionnaire, Publish) uses this. `notSaved` is the page's own words for a failed save.
 * When the page's saver changes, the alert of a Sign out stop goes if every cause it names is resolved (retireResolvedStop).
 */
export function useLeaveGuard(site: Pick<SiteState, "flush" | "saving" | "saver" | "stopCause">, stopped: (result: false | "dropped") => void, notSaved?: string): void {
  const { flush, saving, stopCause } = site;
  const latest = useRef({ stopped, notSaved });
  useEffect(() => {
    latest.current = { stopped, notSaved };
  });
  useEffect(() => {
    setLeaveGuard({ flush, saving, stopped: (result) => latest.current.stopped(result), cause: (result) => stopCause(result, latest.current.notSaved) });
    return () => setLeaveGuard(null);
  }, [flush, saving, stopCause]);
  const { status, wordingDropped } = site.saver;
  useEffect(() => {
    retireResolvedStop();
  }, [status, wordingDropped]);
}

/** The causes the owner was told about (by key), the causes the alert on screen names, and the press in progress. */
let told = new Map<string, StopCause>();
let shown: StopCause[] = [];
let presses = 0;
let waiting = false;
let firstPressAt = 0;
let stopSay: ((message: string | null) => void) | null = null;

/** How long a first press waits alone: absorbs a double-click, and leaves time to read the message. */
export const SIGN_OUT_GRACE_MS = 1_500;

/** A new page is on screen: its stops are its own to say. */
export function resetSignOutStop(): void {
  told = new Map();
  shown = [];
}

/** The alert goes when every cause it names is resolved (a save was answered, the notice was dismissed, the conflicted draft was reloaded). */
function retireResolvedStop(): void {
  if (shown.length === 0 || shown.some((cause) => cause.still())) return;
  shown = [];
  stopSay?.(null);
}

/** Saves the page on screen, settles the saves closed editors left, and answers the causes still unsaved. */
async function collectCauses(): Promise<StopCause[]> {
  const causes: StopCause[] = [];
  const guard = leaveGuard;
  if (guard !== null) {
    const result = await guard.flush();
    if (result !== true) {
      // A failed save is said by the alert alone (the page would say the same words again); a drop also focuses the page's own notice.
      if (result === "dropped") guard.stopped(result);
      const cause = guard.cause(result);
      if (cause !== null) causes.push(cause);
    }
  }
  return [...causes, ...(await settleLeaving())];
}

/**
 * Whether the session may end now (the rules at the top of this section). `say` gets the alert: "Saving…" and PRESS_AGAIN while a
 * press has to wait, then, if it stops, the text of the causes not told yet and PRESS_AGAIN. A press overtaken by a later one ends silently.
 */
export async function mayEndSession(say: (message: string | null) => void): Promise<boolean> {
  const pressing = waiting || shown.length > 0;
  if (pressing && performance.now() - firstPressAt < SIGN_OUT_GRACE_MS) return false;
  if (waiting) {
    presses += 1;
    return true;
  }
  const mine = ++presses;
  waiting = true;
  firstPressAt = performance.now();
  shown = [];
  // "Saving…" only when a save is actually pending; with nothing to save the press goes on at once and nothing is shown.
  const saving = hasClosingSave() || (leaveGuard?.saving() ?? false);
  if (saving) say(`${SAVING} ${PRESS_AGAIN}`);
  try {
    const causes = await collectCauses();
    if (mine !== presses) return false;
    const untold = causes.filter((cause) => !sameIncident(cause, told.get(cause.key)));
    told = new Map(causes.map((cause) => [cause.key, cause]));
    if (untold.length === 0) {
      if (saving) say(null);
      return true;
    }
    shown = untold;
    for (const cause of untold) cause.shown?.();
    stopSay = say;
    say(`${[...new Set(untold.map((cause) => cause.text))].join(" ")} ${PRESS_AGAIN}`);
    return false;
  } finally {
    if (mine === presses) waiting = false;
  }
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
