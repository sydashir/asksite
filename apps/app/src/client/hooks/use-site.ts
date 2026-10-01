import type { OwnerEdits, SiteView } from "@asksite/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, GENERIC_ERROR_MESSAGE } from "../lib/api.ts";
import { AutoSaver, type DraftPatch, type SaverState } from "../lib/autosave.ts";

export interface Draft {
  facts: unknown;
  brief: unknown;
  edits: OwnerEdits;
}

export type SiteLoad = { state: "loading" } | { state: "error"; message: string; status: number } | { state: "ready"; view: SiteView };

/** Saves a page started as it closed, by site: the next page's first load waits for them (decision 37). */
const leaving = new Map<string, Promise<unknown>>();

/**
 * One site's server view plus the owner's local draft. Every change is shown at once and saved
 * in the background (AutoSaver); `issues` are the server's answer to the last save. Nothing typed is
 * dropped: `reload` saves first, and leaving the page sends whatever is still unsaved.
 */
export function useSite(siteId: string) {
  const [load, setLoad] = useState<SiteLoad>({ state: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saver, setSaverState] = useState<SaverState>({ status: "idle", rev: 0 });
  const saverRef = useRef<AutoSaver | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [locked, setLocked] = useState(false);

  const reload = useCallback(async () => {
    // Save what is typed first (after a conflict this does nothing: the reload shows the newer
    // version on purpose), and wait for a save the previous page started as it closed.
    if (saverRef.current !== null) await saverRef.current.flush();
    await leaving.get(siteId);
    const res = await api<SiteView>("GET", `/api/sites/${siteId}`);
    if (!res.ok) {
      setLoad({ state: "error", message: res.error.message, status: res.status });
      return null;
    }
    saverRef.current?.dispose();
    saverRef.current = new AutoSaver(res.data.rev, async (rev, patch) => {
      const saved = await api<{ rev: number; issues: SiteView["issues"] }>("PATCH", `/api/sites/${siteId}/draft`, { rev, ...patch });
      if (saved.ok) {
        // A 2xx whose body could not be read has no rev: that is a failed save, not a saved one.
        if (typeof saved.data?.rev !== "number") return { ok: false, conflict: false, message: GENERIC_ERROR_MESSAGE };
        return { ok: true, rev: saved.data.rev, issues: saved.data.issues };
      }
      return { ok: false, conflict: saved.error.code === "conflict", message: saved.error.message };
    }, setSaverState);
    setSaverState({ status: "idle", rev: res.data.rev, issues: res.data.issues });
    draftRef.current = { facts: res.data.facts, brief: res.data.brief, edits: res.data.edits };
    setDraft(draftRef.current);
    setLoad({ state: "ready", view: res.data });
    return res.data;
  }, [siteId]);

  useEffect(() => {
    void reload();
    return () => {
      // Leaving by any route (a link, the browser's Back): send what is still unsaved instead of dropping it.
      const current = saverRef.current;
      if (current === null) return;
      const saving: Promise<unknown> = current.flush().finally(() => {
        if (leaving.get(siteId) === saving) leaving.delete(siteId);
      });
      leaving.set(siteId, saving);
    };
  }, [reload, siteId]);

  /** Apply a change computed from the newest draft, show it at once and queue it for saving. */
  const update = useCallback((change: (current: Draft) => DraftPatch) => {
    const current = draftRef.current;
    if (current === null) return;
    const patch = change(current);
    draftRef.current = { ...current, ...patch } as Draft;
    setDraft(draftRef.current);
    saverRef.current?.change(patch);
  }, []);

  /**
   * Runs a change that bumps the site's rev outside the autosaver (the web address), with the answer fields
   * locked meanwhile: anything typed during it would be saved with the old rev, refused, and dropped by the reload.
   */
  const exclusive = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    setLocked(true);
    try {
      return await work();
    } finally {
      setLocked(false);
    }
  }, []);

  const flush = useCallback(async () => (saverRef.current === null ? true : saverRef.current.flush()), []);
  const rev = () => saverRef.current?.currentRev ?? 0;

  return { load, draft, saver, locked, update, exclusive, flush, reload, rev };
}

export type SiteState = ReturnType<typeof useSite>;
