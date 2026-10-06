import type { OwnerEdits, SiteView } from "@asksite/core";
import { GENERIC_ERROR_MESSAGE } from "./api.ts";

// Draft autosave (§3.1 step 5): changes are saved 800 ms after the last one, one request at a
// time, always with the newest values and the last rev the server gave. A 409 stops saving until
// the owner reloads, so a stale tab never overwrites newer work.

export interface DraftPatch {
  facts?: unknown;
  brief?: unknown;
  edits?: OwnerEdits;
}

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error" | "conflict";

/**
 * `refused` is set only when the server stored NOTHING because new wording is being written (generation_in_progress). The save is
 * not retried and its change is not kept as unsaved: the caller has put the draft back to what the server holds, and the owner is told.
 */
export type SaveResult =
  | { ok: true; rev: number; issues: SiteView["issues"]; wordingDropped?: true }
  | { ok: false; conflict: boolean; message: string; refused?: true };

export interface SaverState {
  status: SaveStatus;
  rev: number;
  issues?: SiteView["issues"];
  message?: string;
  /**
   * Up from the first save that applied without the owner's wording or order change (new wording had arrived: the server's
   * wording_changed) until the owner has seen it. Every later state of the run carries it; a later 'saved' never clears it.
   */
  wordingDropped?: true;
  /** With wordingDropped: the change was refused while new wording is being written (not because new wording arrived), so the notice says that. */
  droppedWhileWriting?: true;
}

/** An unseen drop as a replacement saver must carry it: which notice it is, and whether a leave was already stopped for it. */
export interface DropState {
  stopped: boolean;
  whileWriting: boolean;
}

/**
 * Whether a reload may replace the local draft after a flush. Only when everything is saved, or the save stopped on a conflict
 * (the owner asked for the newer version on purpose). A failed save keeps its unsaved values: replacing them would lose them.
 */
export const mayReplaceDraft = (saved: boolean, status: SaveStatus): boolean => saved || status === "conflict";

/** What flush answers: true (all saved), false (not saved), or "dropped" (saved, but the owner's wording change was not applied and they have not been told yet). */
export type FlushResult = boolean | "dropped";

export type SendPatch = (rev: number, patch: DraftPatch) => Promise<SaveResult>;

export class AutoSaver {
  private pending: DraftPatch = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private rev: number;
  private status: SaveStatus = "idle";
  private last: SaverState;
  // The run-level notice: set by a save that dropped the owner's wording, cleared only by the owner having seen it.
  private wordingDropped = false;
  // A leaving action has already been stopped for this drop; the next one goes through.
  private stopped = false;
  // The drop is a refusal made while new wording is being written (it has its own notice).
  private whileWriting = false;
  // Counts the drops this saver has found. A flush compares it with the count at its start: a drop found by the flush itself is new
  // to the owner, so that flush stops even when an earlier drop was already shown (the drop epoch).
  private dropsFound = 0;
  // Counts the saves the server answered for good: accepted, or refused (it stored nothing and the unsaved values were dropped). A failed
  // save does not move it. Sign out tells "the same unsaved change" from a new one by it.
  private settledCount = 0;
  private disposed = false;
  private readonly send: SendPatch;
  private readonly report: (state: SaverState) => void;
  private readonly delayMs: number;

  constructor(rev: number, send: SendPatch, report: (state: SaverState) => void, delayMs = 800) {
    this.rev = rev;
    this.last = { status: "idle", rev };
    this.send = send;
    this.report = report;
    this.delayMs = delayMs;
  }

  get currentRev(): number {
    return this.rev;
  }

  get currentStatus(): SaveStatus {
    return this.status;
  }

  /** How many saves the server has answered for good (accepted or refused) from this saver: a failed save does not count. */
  get settled(): number {
    return this.settledCount;
  }

  /** Replaced by a newer saver (a reload): it holds nothing the owner still has to be told about. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Whether a flush would send a save now: something is unsent or in flight (a conflict sends nothing). */
  get hasUnsent(): boolean {
    return this.status !== "conflict" && (Object.keys(this.pending).length > 0 || this.running !== null);
  }

  change(patch: DraftPatch): void {
    this.pending = { ...this.pending, ...patch };
    if (this.status === "conflict") return;
    this.update({ status: "pending", rev: this.rev });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.delayMs);
  }

  /** Save everything now. Resolves true when nothing is left unsaved. */
  async saveNow(): Promise<boolean> {
    clearTimeout(this.timer);
    await this.run();
    return this.status !== "conflict" && this.status !== "error" && Object.keys(this.pending).length === 0;
  }

  /**
   * saveNow for an action that leaves the editor (Publish, Messages, reload, a link). When the owner's wording change was dropped
   * and they have not been told yet, it answers "dropped" so the action stops; an attempt that STARTS after the owner was stopped once
   * (and did not itself find a new drop) clears the notice and goes on. Whether this is the second attempt is decided before
   * anything is awaited: a double click runs two flushes over one save, and both of them stop. A drop found while this flush ran
   * (dropsFound moved) is new to the owner: this flush stops too.
   */
  async flush(): Promise<FlushResult> {
    const secondAttempt = this.wordingDropped && this.stopped;
    const dropsAtStart = this.dropsFound;
    if (!(await this.saveNow())) return false;
    if (!this.wordingDropped) return true;
    if (secondAttempt && this.dropsFound === dropsAtStart) {
      this.acknowledgeDrop();
      return true;
    }
    this.stopped = true;
    return "dropped";
  }

  /** The drop that is up and not dismissed, or null: a replacement saver must carry it (restoreDrop) or it is lost. */
  get unseenDrop(): DropState | null {
    return this.wordingDropped ? { stopped: this.stopped, whileWriting: this.whileWriting } : null;
  }

  /** The owner has seen the notice (dismissed it, or tried again): it goes, and nothing stops them again for this drop. */
  acknowledgeDrop(): void {
    if (!this.wordingDropped) return;
    this.wordingDropped = false;
    this.stopped = false;
    this.whileWriting = false;
    const { wordingDropped: _seen, droppedWhileWriting: _writing, ...rest } = this.last;
    this.update(rest);
  }

  /**
   * Raises the notice for a drop this saver did not see happen: one found while the editor was closing (its save finished after the
   * screen went: not stopped yet) or one carried over an in-page reload (stopped as it was: the same drop never stops a leave twice).
   */
  restoreDrop(drop: DropState = { stopped: false, whileWriting: false }): void {
    this.wordingDropped = true;
    this.stopped = drop.stopped;
    this.whileWriting = drop.whileWriting;
    this.update({ ...this.last });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  private run(): Promise<void> {
    this.running ??= this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<void> {
    while (Object.keys(this.pending).length > 0 && this.status !== "conflict") {
      const patch = this.pending;
      this.pending = {};
      this.update({ status: "saving", rev: this.rev });
      const result = await this.sendSafely(patch);
      if (result.ok) {
        this.rev = result.rev;
        this.settledCount += 1;
        if (result.wordingDropped === true) {
          this.dropsFound += 1;
          this.wordingDropped = true;
          this.stopped = false;
          this.whileWriting = false;
        }
        this.update({
          status: Object.keys(this.pending).length > 0 ? "saving" : "saved",
          rev: this.rev,
          issues: result.issues,
        });
        continue;
      }
      if (result.refused === true) {
        // Stored nothing, and the draft was put back to what the server holds: there is no unsaved value to keep and nothing to send again.
        // Anything typed while this save was in flight is dropped with the reset (the screen was reset to the stored values, so it is not
        // on screen either): it is never sent later, when the rewrite may have ended, behind the owner's back.
        clearTimeout(this.timer);
        this.pending = {};
        this.settledCount += 1;
        this.dropsFound += 1;
        this.wordingDropped = true;
        this.stopped = false;
        this.whileWriting = true;
        this.update({ status: "saved", rev: this.rev, ...(this.last.issues === undefined ? {} : { issues: this.last.issues }) });
        continue;
      }
      // Keep the unsaved values; anything typed meanwhile is newer and wins.
      this.pending = { ...patch, ...this.pending };
      this.update({ status: result.conflict ? "conflict" : "error", rev: this.rev, message: result.message });
      return;
    }
  }

  /** A send that throws (a dropped connection, an unreadable answer) is an error, never a lost patch. */
  private async sendSafely(patch: DraftPatch): Promise<SaveResult> {
    try {
      return await this.send(this.rev, patch);
    } catch {
      return { ok: false, conflict: false, message: GENERIC_ERROR_MESSAGE };
    }
  }

  private update(state: SaverState): void {
    this.status = state.status;
    this.last = this.wordingDropped ? { ...state, wordingDropped: true, ...(this.whileWriting ? { droppedWhileWriting: true as const } : {}) } : state;
    this.report(this.last);
  }
}
