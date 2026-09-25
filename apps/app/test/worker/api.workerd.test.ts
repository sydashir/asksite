import { describe, expect, it } from "vitest";
import { API_HEADERS } from "@asksite/app-common";
import { nextIp, useAppHarness } from "../support/harness.ts";

const h = useAppHarness();

describe("API conventions (§4.1)", () => {
  it("answers an unknown /api path with a JSON 404 and every API header", async () => {
    const res = await h.call("GET", "/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
    for (const [name, value] of Object.entries(API_HEADERS)) expect(res.headers.get(name)).toBe(value);
  });

  it("refuses a state change from another origin, or with no Origin (CSRF)", async () => {
    for (const origin of ["https://evil.example", null]) {
      const res = await h.call("POST", "/api/nope", { body: {}, origin, ip: nextIp() });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    }
  });
});
