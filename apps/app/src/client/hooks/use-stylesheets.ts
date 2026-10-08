import { useCallback, useEffect, useReducer, useState } from "react";
import { loadRenderer } from "../lib/preview.ts";
import { sheetsReducer, startSheetsLoad, type SheetsState } from "../lib/preview-sheets.ts";

/** The preview's renderer and design stylesheets (one lazy chunk): their state, and `retry`, which asks the loader again. */
export function useStylesheets(): [SheetsState, () => void] {
  const [state, dispatch] = useReducer(sheetsReducer, { status: "loading", failures: 0 });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => startSheetsLoad(loadRenderer, dispatch), [attempt]);
  const retry = useCallback(() => {
    dispatch({ type: "retry" });
    setAttempt((n) => n + 1);
  }, []);
  return [state, retry];
}
