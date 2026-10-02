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

export type SaveResult =
  | { ok: true; rev: number; issues: SiteView["issues"]; wordingDropped?: true }
  | { ok: false; conflict: boolean; message: string };

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
   * and they have not been told yet, it answers "dropped" ONCE so the action stops; the next attempt clears the notice and goes on.
   */
  async flush(): Promise<FlushResult> {
    if (!(await this.saveNow())) return false;
    if (!this.wordingDropped) return true;
    if (!this.stopped) {
      this.stopped = true;
      return "dropped";
    }
    this.acknowledgeDrop();
    return true;
  }

  /** The owner has seen the notice (dismissed it, or tried again): it goes, and nothing stops them again for this drop. */
  acknowledgeDrop(): void {
    if (!this.wordingDropped) return;
    this.wordingDropped = false;
    this.stopped = false;
    const { wordingDropped: _seen, ...rest } = this.last;
    this.update(rest);
  }

  /** Raises the notice for a drop that happened while the editor was closing (its save finished after the screen went). */
  restoreDrop(): void {
    this.wordingDropped = true;
    this.stopped = false;
    this.update({ ...this.last });
  }

  dispose(): void {
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
        if (result.wordingDropped === true) {
          this.wordingDropped = true;
          this.stopped = false;
        }
        this.update({
          status: Object.keys(this.pending).length > 0 ? "saving" : "saved",
          rev: this.rev,
          issues: result.issues,
        });
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
    this.last = this.wordingDropped ? { ...state, wordingDropped: true } : state;
    this.report(this.last);
  }
}
