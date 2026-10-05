import type { SaverState } from "./autosave.ts";

/** Said instead of "All changes saved." (and whatever else is settled) while the save kept the owner's other changes but not their wording change. */
export const WORDING_DROPPED = "New wording arrived, so your last wording change wasn't applied. Make it again on the new wording if you still want it.";

/** Said when the server refused the owner's change because new wording is being written: nothing was stored, and the editor is locked until it is ready. */
export const WRITING_DROPPED = "New wording is being written. Your last change was not saved. Make it again when the new wording is ready.";

/** Said when a save failed for any reason but a conflict. */
export const NOT_SAVED = "Your latest changes are not saved yet. Please try again in a moment.";

/** Said when the save was refused because another tab or window saved the site first. */
export const CONFLICT_MESSAGE = "This site changed in another tab or window. Reload to see the latest version.";

/** Added to every message that stops "Sign out": the owner has been told, so the next press goes on. */
export const PRESS_AGAIN = "Press Sign out again to sign out without saving.";

/** The text that stops "Sign out": what is wrong (the existing wording for it), then PRESS_AGAIN. */
export function signOutStopMessage(reason: { dropped: false | { whileWriting: boolean }; status: SaverState["status"]; notSaved?: string }): string {
  const { dropped, status, notSaved = NOT_SAVED } = reason;
  const text = dropped !== false ? (dropped.whileWriting ? WRITING_DROPPED : WORDING_DROPPED) : status === "conflict" ? CONFLICT_MESSAGE : notSaved;
  return `${text} ${PRESS_AGAIN}`;
}

/**
 * What the save status says. A failed save's own warning comes first; the wording notice then stays through every later save
 * (also while saving) until the owner has seen it; only without it can everything be "saved". Typing alone says nothing.
 */
export function saveAnnouncement(state: SaverState): string {
  if (state.status === "error") return `Your changes are not saved yet. ${state.message ?? ""}`;
  if (state.status === "conflict") return CONFLICT_MESSAGE;
  if (state.wordingDropped === true) return state.droppedWhileWriting === true ? WRITING_DROPPED : WORDING_DROPPED;
  return state.status === "saved" ? "All changes saved." : "";
}
