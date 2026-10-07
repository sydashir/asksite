import type { FlushResult } from "./autosave.ts";
import type { Renderer } from "./preview.ts";

/** Where the preview's renderer and design stylesheets stand: loading (the lazy chunk), ready, or failed (counted, so a repeat is told from a first). */
export type SheetsState = { status: "loading"; failures: number } | { status: "ready"; renderer: Renderer } | { status: "failed"; failures: number };
export type SheetsEvent = { type: "retry" } | { type: "loaded"; renderer: Renderer } | { type: "failed" };

export function sheetsReducer(state: SheetsState, event: SheetsEvent): SheetsState {
  const failures = state.status === "ready" ? 0 : state.failures;
  switch (event.type) {
    case "loaded":
      return { status: "ready", renderer: event.renderer };
    case "failed":
      return { status: "failed", failures: failures + 1 };
    case "retry":
      return { status: "loading", failures };
  }
}

/**
 * Asks the loader for the renderer and reports the answer, unless the returned function was called first (the screen went
 * away). The UI is driven only by the loader's rejections: nothing listens for vite:preloadError, and nothing prevents its default.
 */
export function startSheetsLoad(load: () => Promise<Renderer>, dispatch: (event: SheetsEvent) => void): () => void {
  let live = true;
  load().then(
    (renderer) => live && dispatch({ type: "loaded", renderer }),
    () => live && dispatch({ type: "failed" }),
  );
  return () => {
    live = false;
  };
}

export const PREVIEW_FIRST_FAILURE = "The preview couldn't load.";
export const PREVIEW_STILL_FAILING = "The preview still can't load.";
export const SAVED_NOTE = "Your changes are saved.";

/** The first failure, or any failure on a page that was itself a reload or after "Try again", says "still". Fixed text: it is a live region. */
export function previewFailureText(failures: number, afterReload: boolean): string {
  return failures >= 2 || afterReload ? PREVIEW_STILL_FAILING : PREVIEW_FIRST_FAILURE;
}

/**
 * Saves what is typed, then reloads; a failed save (or one that throws) reloads nothing, so no change is lost, and neither does a
 * save that dropped the owner's wording ("dropped": they are told first). Returns true when it reloaded, else why it did not.
 */
export async function reloadAfterSave(flush: () => Promise<FlushResult>, reload: () => void): Promise<true | false | "dropped"> {
  const saved = await flush().catch(() => false);
  if (saved !== true) return saved;
  reload();
  return true;
}
