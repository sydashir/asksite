import type { AutoSaver } from "./autosave.ts";
import { stopText } from "./save-message.ts";

/** Why "Sign out" may have to stop: the page on screen (own, wording drop) or an editor that was closed (closing). */
export type CauseKind = "own-failure" | "own-conflict" | "wording-drop" | "closing-failed" | "closing-conflict" | "closing-drop";

/**
 * One reason "Sign out" stops, identified by its site and kind. `source` and `settled` say WHICH incident it is (the saver or drop it
 * came from, and how many saves the server had answered for good, accepted or refused): the same cause with the same stamp is the one the
 * owner was already told about, a failure that comes back after a save was answered is a new one. `still` says whether the cause is still true now.
 */
export interface StopCause {
  key: string;
  text: string;
  source: object;
  settled: number;
  still: () => boolean;
  /** Called when a Sign out stop SHOWS this cause: it marks, in place, what the owner has now been told (a closing drop is stopped for). */
  shown?: () => void;
}

export const causeKey = (siteId: string, kind: CauseKind): string => `${siteId}|${kind}`;

/** Whether `told` (what the owner was told, or nothing) is the very incident `cause` is. */
export const sameIncident = (cause: StopCause, told: StopCause | undefined): boolean =>
  told !== undefined && told.key === cause.key && told.source === cause.source && told.settled === cause.settled;

/** The cause of a flush of the page on screen that did not end clean (false: not saved or in conflict; "dropped": saved without the wording change). */
export function pageCause(siteId: string, saver: AutoSaver, result: false | "dropped", notSaved?: string): StopCause {
  const settled = saver.settled;
  const base = { source: saver, settled };
  if (result === "dropped") {
    const text = stopText({ dropped: { whileWriting: saver.unseenDrop?.whileWriting ?? false }, status: saver.currentStatus });
    // Gone once a save is answered (accepted or refused) or the owner dismisses the notice.
    return { ...base, key: causeKey(siteId, "wording-drop"), text, still: () => saver.settled === settled && saver.unseenDrop !== null };
  }
  if (saver.currentStatus === "conflict") return { ...base, key: causeKey(siteId, "own-conflict"), text: stopText({ dropped: false, status: "conflict" }), still: () => !saver.isDisposed };
  return { ...base, key: causeKey(siteId, "own-failure"), text: stopText({ dropped: false, status: saver.currentStatus, ...(notSaved === undefined ? {} : { notSaved }) }), still: () => saver.settled === settled };
}
