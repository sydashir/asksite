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
  | { ok: true; rev: number; issues: SiteView["issues"] }
  | { ok: false; conflict: boolean; message: string };

export interface SaverState {
  status: SaveStatus;
  rev: number;
  issues?: SiteView["issues"];
  message?: string;
}

export type SendPatch = (rev: number, patch: DraftPatch) => Promise<SaveResult>;

export class AutoSaver {
  private pending: DraftPatch = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private rev: number;
  private status: SaveStatus = "idle";
  private readonly send: SendPatch;
  private readonly report: (state: SaverState) => void;
  private readonly delayMs: number;

  constructor(rev: number, send: SendPatch, report: (state: SaverState) => void, delayMs = 800) {
    this.rev = rev;
    this.send = send;
    this.report = report;
    this.delayMs = delayMs;
  }

  get currentRev(): number {
    return this.rev;
  }

  change(patch: DraftPatch): void {
    this.pending = { ...this.pending, ...patch };
    if (this.status === "conflict") return;
    this.update({ status: "pending", rev: this.rev });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.delayMs);
  }

  /** Save everything now. Resolves true when nothing is left unsaved. */
  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    await this.run();
    return this.status !== "conflict" && this.status !== "error" && Object.keys(this.pending).length === 0;
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
        this.update({ status: Object.keys(this.pending).length > 0 ? "saving" : "saved", rev: this.rev, issues: result.issues });
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
    this.report(state);
  }
}
