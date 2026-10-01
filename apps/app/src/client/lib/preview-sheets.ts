import type { DesignStylesheets } from "@asksite/renderer";

/** Where the preview's design stylesheets stand: loading (the lazy chunk), ready, or failed (counted, so a repeat is told from a first). */
export type SheetsState = { status: "loading"; failures: number } | { status: "ready"; sheets: DesignStylesheets } | { status: "failed"; failures: number };
export type SheetsEvent = { type: "retry" } | { type: "loaded"; sheets: DesignStylesheets } | { type: "failed" };

export function sheetsReducer(state: SheetsState, event: SheetsEvent): SheetsState {
  const failures = state.status === "ready" ? 0 : state.failures;
  switch (event.type) {
    case "loaded":
      return { status: "ready", sheets: event.sheets };
    case "failed":
      return { status: "failed", failures: failures + 1 };
    case "retry":
      return { status: "loading", failures };
  }
}

/**
 * Asks the loader for the sheets and reports the answer, unless the returned function was called first (the screen went
 * away). The UI is driven only by the loader's rejections: nothing listens for vite:preloadError, and nothing prevents its default.
 */
export function startSheetsLoad(load: () => Promise<DesignStylesheets>, dispatch: (event: SheetsEvent) => void): () => void {
  let live = true;
  load().then(
    (sheets) => live && dispatch({ type: "loaded", sheets }),
    () => live && dispatch({ type: "failed" }),
  );
  return () => {
    live = false;
  };
}

export const PREVIEW_FIRST_FAILURE = "The preview couldn't load.";
export const PREVIEW_STILL_FAILING = "The preview still can't load.";
export const SAVED_NOTE = "Your changes are saved.";

/**
 * The first failure, or any failure on a page that was itself a reload or after "Try again", says "still". The saved note is
 * added only while the editor says saved (`saved`): while changes are waiting, saving or failed, the save status speaks.
 */
export function previewFailureText(failures: number, afterReload: boolean, saved: boolean): string {
  const text = failures >= 2 || afterReload ? PREVIEW_STILL_FAILING : PREVIEW_FIRST_FAILURE;
  return saved ? `${text} ${SAVED_NOTE}` : text;
}

/** Saves what is typed, then reloads; a failed save (or one that throws) reloads nothing, so no change is lost. Returns whether it reloaded. */
export async function reloadAfterSave(flush: () => Promise<boolean>, reload: () => void): Promise<boolean> {
  const saved = await flush().catch(() => false);
  if (!saved) return false;
  reload();
  return true;
}
