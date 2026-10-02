import type { CurrentAi, OwnerEdits, SiteView } from "@asksite/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, GENERIC_ERROR_MESSAGE } from "../lib/api.ts";
import { AutoSaver, mayReplaceDraft, type DraftPatch, type SaverState, type SendPatch } from "../lib/autosave.ts";
import { editsForAi } from "../lib/edits.ts";

export interface Draft {
  facts: unknown;
  brief: unknown;
  edits: OwnerEdits;
}

export type SiteLoad = { state: "loading" } | { state: "error"; message: string; status: number } | { state: "ready"; view: SiteView };

/** Saves a page started as it closed, by site: the next page's first load waits for them (decision 37). */
const leaving = new Map<string, Promise<unknown>>();

const AI_RETRY_MS = 1_000;

/** The site's newest view, or null when it could not be fetched or read (it has no AI wording, or the answer is not a view). */
async function fetchAi(siteId: string): Promise<SiteView | null> {
  const res = await api<SiteView>("GET", `/api/sites/${siteId}`);
  if (!res.ok) return null;
  const view = res.data as Partial<SiteView> | null;
  const readable = typeof view === "object" && view !== null && view.ai != null && typeof view.edits === "object" && view.edits !== null && view.limits != null;
  return readable ? (res.data as SiteView) : null;
}

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
  // The AI draft the editor shows: the generation an edit's wording and order are bound to.
  const aiRef = useRef<CurrentAi | null>(null);
  const [locked, setLocked] = useState(false);

  /**
   * Takes only the AI's wording (and the counters beside it) from the server's newest view. The owner's local draft and the
   * saver stay exactly as they are, so nothing typed or still unsaved is replaced and the saver's rev is never touched. The one
   * thing taken from the server's edits is the look it pinned before the rewrite (the owner never chose one): while the owner
   * has none, the page would otherwise jump to the new draft's look. That look is already the server's, so nothing is saved.
   * Resolves to the newest view once the wording is refreshed. A failed GET or an unreadable answer is tried once more, then it
   * resolves null (never throws): the caller must not treat the wording as new, because an edit built on the old draft is refused.
   */
  const refreshFresh = useCallback(async (): Promise<SiteView | null> => {
    let fresh = await fetchAi(siteId);
    if (fresh === null) {
      await new Promise((resolve) => setTimeout(resolve, AI_RETRY_MS));
      fresh = await fetchAi(siteId);
    }
    if (fresh === null || fresh.ai === null) return null;
    const ai = fresh.ai;
    aiRef.current = { generationId: ai.generationId, draft: ai.draft };
    const current = draftRef.current;
    if (current !== null && current.edits.theme === null && fresh.edits.theme !== null) {
      draftRef.current = { ...current, edits: { ...current.edits, theme: fresh.edits.theme } };
      setDraft(draftRef.current);
    }
    setLoad((last) => (last.state === "ready" ? { state: "ready", view: { ...last.view, ai, limits: fresh.limits, activeGeneration: fresh.activeGeneration } } : last));
    return fresh;
  }, [siteId]);

  /** Resolves true once the AI's wording is refreshed (refreshFresh). */
  const refreshAi = useCallback(async (): Promise<boolean> => (await refreshFresh()) !== null, [refreshFresh]);

  /** Taken only after a refused save: refreshes the AI wording (refreshFresh) and tries once more without the stale wording and order. */
  const saveDraft = useCallback<SendPatch>(async (rev, patch) => {
    const send = (body: DraftPatch) => api<{ rev: number; issues: SiteView["issues"] }>("PATCH", `/api/sites/${siteId}/draft`, { rev, ...body });
    let saved = await send(patch);
    let wordingDropped = false;
    // New wording arrived since this tab last loaded: the server refused the wording or order change and stored nothing (the rev is untouched).
    // Hidden sections and the look carry over, so the rest of the save goes through on the new wording; the owner is told the change is gone.
    if (!saved.ok && saved.error.code === "wording_changed" && patch.edits !== undefined) {
      const fresh = await refreshFresh();
      if (fresh !== null && fresh.ai !== null) {
        saved = await send({ ...patch, edits: editsForAi({ generationId: fresh.ai.generationId, draft: fresh.ai.draft }, patch.edits) });
        wordingDropped = true;
      }
    }
    if (saved.ok) {
      // A 2xx whose body could not be read has no rev: that is a failed save, not a saved one.
      if (typeof saved.data?.rev !== "number") return { ok: false, conflict: false, message: GENERIC_ERROR_MESSAGE };
      return { ok: true, rev: saved.data.rev, issues: saved.data.issues, ...(wordingDropped ? { wordingDropped: true as const } : {}) };
    }
    return { ok: false, conflict: saved.error.code === "conflict", message: saved.error.message };
  }, [siteId, refreshFresh]);

  const reload = useCallback(async () => {
    // Save what is typed first (after a conflict this does nothing: the reload shows the newer version on purpose).
    // A save that failed keeps the draft and the saver as they are: the not-saved warning stays and nothing is replaced.
    const current = saverRef.current;
    if (current !== null && !mayReplaceDraft(await current.flush(), current.currentStatus)) return null;
    // Wait for a save the previous page started as it closed.
    await leaving.get(siteId);
    const res = await api<SiteView>("GET", `/api/sites/${siteId}`);
    if (!res.ok) {
      setLoad({ state: "error", message: res.error.message, status: res.status });
      return null;
    }
    saverRef.current?.dispose();
    saverRef.current = new AutoSaver(res.data.rev, saveDraft, setSaverState);
    setSaverState({ status: "idle", rev: res.data.rev, issues: res.data.issues });
    draftRef.current = { facts: res.data.facts, brief: res.data.brief, edits: res.data.edits };
    aiRef.current = res.data.ai === null ? null : { generationId: res.data.ai.generationId, draft: res.data.ai.draft };
    setDraft(draftRef.current);
    setLoad({ state: "ready", view: res.data });
    return res.data;
  }, [siteId, saveDraft]);

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
    // Wording and order are bound to the AI draft the editor shows: edits left over from an older one are inert (compose ignores them),
    // so they are not sent, and the server (which refuses a wording save on any other generation) never sees them.
    const ai = aiRef.current;
    if (patch.edits !== undefined && ai !== null) patch.edits = editsForAi(ai, patch.edits);
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

  return { load, draft, saver, locked, update, exclusive, flush, reload, refreshAi, rev };
}

export type SiteState = ReturnType<typeof useSite>;
