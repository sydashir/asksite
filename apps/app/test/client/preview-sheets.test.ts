import type { DesignStylesheets } from "@asksite/renderer";
import { describe, expect, it } from "vitest";
import { stubStylesheets } from "../../../../fixtures/index.ts";
import { stylesheetLoader } from "../../src/client/lib/preview.ts";
import { PREVIEW_STILL_FAILING, PREVIEW_FIRST_FAILURE, SAVED_NOTE, previewFailureText, reloadAfterSave, sheetsReducer, startSheetsLoad, type SheetsEvent, type SheetsState } from "../../src/client/lib/preview-sheets.ts";

const sheets: DesignStylesheets = stubStylesheets();
const failing = () => new TypeError("Failed to fetch dynamically imported module");

describe("the preview's stylesheet state (task-17-extra B3)", () => {
  it("starts loading, becomes ready with the sheets, and counts each failure", () => {
    const start: SheetsState = { status: "loading", failures: 0 };
    expect(sheetsReducer(start, { type: "loaded", sheets })).toEqual({ status: "ready", sheets });
    const once = sheetsReducer(start, { type: "failed" });
    expect(once).toEqual({ status: "failed", failures: 1 });
    expect(sheetsReducer(sheetsReducer(once, { type: "retry" }), { type: "failed" })).toEqual({ status: "failed", failures: 2 });
    // Asking again keeps the count while it loads, so a second failure is told from a first.
    expect(sheetsReducer(once, { type: "retry" })).toEqual({ status: "loading", failures: 1 });
  });

  it("says 'couldn't load' on the first failure, and 'still can't load' on a failure after Try again or on a page that was itself a reload", () => {
    expect(previewFailureText(1, false)).toBe(PREVIEW_FIRST_FAILURE);
    expect(previewFailureText(2, false)).toBe(PREVIEW_STILL_FAILING);
    expect(previewFailureText(1, true)).toBe(PREVIEW_STILL_FAILING);
    expect(PREVIEW_FIRST_FAILURE).toBe("The preview couldn't load.");
    expect(PREVIEW_STILL_FAILING).toBe("The preview still can't load.");
  });

  it("keeps the failure text free of the save state (it is a live region); the saved note is its own text", () => {
    expect(SAVED_NOTE).toBe("Your changes are saved.");
    for (const [failures, afterReload] of [[1, false], [2, false], [1, true]] as const) expect(previewFailureText(failures, afterReload)).not.toContain("saved");
  });

  it("runs a failing importer through the real loader: failure, failure, then Try again succeeds (a failed import is not kept)", async () => {
    let imports = 0;
    const load = stylesheetLoader(async () => {
      imports += 1;
      if (imports <= 2) throw failing();
      return { DESIGN_CSS: sheets };
    });
    let state: SheetsState = { status: "loading", failures: 0 };
    const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const dispatch = (event: SheetsEvent) => {
      state = sheetsReducer(state, event);
    };
    startSheetsLoad(load, dispatch);
    await settled();
    expect(state).toEqual({ status: "failed", failures: 1 });
    dispatch({ type: "retry" });
    startSheetsLoad(load, dispatch);
    await settled();
    expect(state).toEqual({ status: "failed", failures: 2 });
    dispatch({ type: "retry" });
    startSheetsLoad(load, dispatch);
    await settled();
    expect(state).toEqual({ status: "ready", sheets });
    expect(imports).toBe(3);
  });

  it("ignores the answer of a load that was cancelled (the screen went away)", async () => {
    const events: SheetsEvent[] = [];
    const cancel = startSheetsLoad(async () => sheets, (event) => events.push(event));
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
  });
});

// STRICT (customer data): no change the owner made may be lost to a reload.
describe("reloadAfterSave", () => {
  it("reloads only after the save finished and succeeded", async () => {
    const log: string[] = [];
    const reloaded = await reloadAfterSave(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.push("saved");
        return true;
      },
      () => log.push("reload"),
    );
    expect(reloaded).toBe(true);
    expect(log).toEqual(["saved", "reload"]);
  });

  it("never reloads when the save failed", async () => {
    let reloads = 0;
    expect(await reloadAfterSave(async () => false, () => (reloads += 1))).toBe(false);
    expect(reloads).toBe(0);
  });

  it("never reloads when saving itself throws", async () => {
    let reloads = 0;
    expect(await reloadAfterSave(async () => { throw new Error("offline"); }, () => (reloads += 1))).toBe(false);
    expect(reloads).toBe(0);
  });
});
