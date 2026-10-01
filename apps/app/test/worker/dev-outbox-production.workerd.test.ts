import { describe, expect, it } from "vitest";
import { useAppHarness } from "../support/harness.ts";

// F17: the outbox holds sign-in and invite links, so it answers only when the Worker runs as development AND the
// host is *.localhost. Here the Worker runs as production on the very host the development outbox answers on, so
// only the ENVIRONMENT half of the guard can refuse (leads.workerd.test.ts covers the host half).
const h = useAppHarness({ vars: { ENVIRONMENT: "production", APP_ORIGIN: "https://app.localhost:8787" } });

describe("GET /api/dev/outbox in production", () => {
  it("is 404 on a *.localhost host, whatever the outbox holds", async () => {
    await (await h.db()).prepare("INSERT INTO dev_outbox (at, to_addr, subject, text, tag) VALUES (1, 'a@example.com', 'Sign in', 'https://app.localhost:8787/login?t=secret', 'magic_link')").bind().run();
    const res = await h.server.fetch("https://app.localhost:8787/api/dev/outbox?to=a@example.com");
    // Anchor: the Worker really runs as production, so a 404 here is the guard's answer and not a missing route.
    expect(res.headers.get("Strict-Transport-Security")).not.toBeNull();
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("secret");
  });
});
