import { describe, expect, it } from "vitest";
import { adminOrigin } from "../../src/client/dev/admin-origin.ts";

describe("adminOrigin", () => {
  it.each([
    [{ protocol: "https:", hostname: "app.localhost", port: "8787" }, "https://admin.localhost:8788"],
    [{ protocol: "https:", hostname: "app.localhost", port: "28787" }, "https://admin.localhost:28788"],
    [{ protocol: "https:", hostname: "localhost", port: "8787" }, null],
    [{ protocol: "https:", hostname: "app.localhost", port: "" }, "https://admin.localhost"],
  ])("%j", (where, expected) => {
    expect(adminOrigin(where)).toBe(expected);
  });
});
