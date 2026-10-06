import { describe, expect, it } from "vitest";
import { retryWriteOnce } from "../src/d1-retry.ts";

const noSleep = async (): Promise<void> => {};
const failing = (messages: string[]) => {
  let calls = 0;
  return {
    run: async (): Promise<string> => {
      const message = messages[calls++];
      if (message !== undefined) throw new Error(message);
      return "done";
    },
    calls: () => calls,
  };
};

describe("retryWriteOnce (D1 retry-queries: retry a write on a transient error)", () => {
  it.each(["D1_ERROR: Network connection lost", "Durable Object storage caused object to be reset.", "D1 DB reset because its code was updated"])(
    "runs once more after %j and returns the second result",
    async (message) => {
      const write = failing([message]);
      expect(await retryWriteOnce(write.run, noSleep)).toBe("done");
      expect(write.calls()).toBe(2);
    },
  );

  it("finds the message in the cause", async () => {
    let calls = 0;
    const run = async (): Promise<string> => {
      if (calls++ === 0) throw new Error("D1_ERROR", { cause: new Error("Network connection lost") });
      return "done";
    };
    expect(await retryWriteOnce(run, noSleep)).toBe("done");
  });

  it("does not retry any other error, and passes it on unchanged", async () => {
    const write = failing(["D1_ERROR: UNIQUE constraint failed: generations.site_id"]);
    await expect(retryWriteOnce(write.run, noSleep)).rejects.toThrow("UNIQUE constraint");
    expect(write.calls()).toBe(1);
    await expect(retryWriteOnce(async () => Promise.reject("not an Error"), noSleep)).rejects.toBe("not an Error");
  });

  it("retries once only: a second transient error propagates", async () => {
    const write = failing(["Network connection lost", "Network connection lost", "Network connection lost"]);
    await expect(retryWriteOnce(write.run, noSleep)).rejects.toThrow("Network connection lost");
    expect(write.calls()).toBe(2);
  });

  it("pauses before the retry", async () => {
    const pauses: number[] = [];
    await retryWriteOnce(failing(["Network connection lost"]).run, async (ms) => void pauses.push(ms));
    expect(pauses).toEqual([250]);
  });
});
