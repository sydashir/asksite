import type { SaverState } from "./autosave.ts";

/** Said instead of "All changes saved." (and whatever else is settled) while the save kept the owner's other changes but not their wording change. */
export const WORDING_DROPPED = "New wording arrived, so your last wording change wasn't applied. Make it again on the new wording if you still want it.";

/** Said when the server refused the owner's change because new wording is being written: nothing was stored, and the editor is locked until it is ready. */
export const WRITING_DROPPED = "New wording is being written. Your last change was not saved. Make it again when the new wording is ready.";

/**
 * What the save status says. A failed save's own warning comes first; the wording notice then stays through every later save
 * (also while saving) until the owner has seen it; only without it can everything be "saved". Typing alone says nothing.
 */
export function saveAnnouncement(state: SaverState): string {
  if (state.status === "error") return `Your changes are not saved yet. ${state.message ?? ""}`;
  if (state.status === "conflict") return "This site changed in another tab or window. Reload to see the latest version.";
  if (state.wordingDropped === true) return state.droppedWhileWriting === true ? WRITING_DROPPED : WORDING_DROPPED;
  return state.status === "saved" ? "All changes saved." : "";
}
