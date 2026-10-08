import { utcDayStart } from "@asksite/core";
import { afterEach, describe, expect, it } from "vitest";
import { useAppHarness } from "../support/harness.ts";

// The near-cap alert with no ADMIN_NOTIFY_EMAILS: it logs that it had nobody to tell and sends nothing.
// Its own file, because the Worker's vars are fixed per harness.
const h = useAppHarness({ vars: { ADMIN_NOTIFY_EMAILS: " , " } });

afterEach(h.clearLoginTokens);

const DAY_MS = 86_400_000;

describe("the near-cap alert with an empty ADMIN_NOTIFY_EMAILS", () => {
  it("logs the alert with no recipients and sends no email", async () => {
    const filler = await h.signIn();
    const left = utcDayStart(Date.now()) + DAY_MS - Date.now();
    if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 1_000));
    const dayStart = utcDayStart(Date.now());
    const db = await h.db();
    for (let i = 0; i < 31; i += 1) {
      await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(`filler-${i}`, filler.ownerId, dayStart, dayStart + 1).run();
    }
    h.server.clearLogs();
    expect((await h.login("no-reviewers@example.com")).status).toBe(202);
    await h.backgroundDone("/api/auth/login");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM dev_outbox WHERE to_addr = ?").bind("no-reviewers@example.com").first()).toEqual({ n: 1 });
    expect(h.logLines().filter((line) => line["event"] === "signin_cap_alert")).toEqual([{ event: "signin_cap_alert", sent: 32, cap: 40, recipients: 0 }]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM dev_outbox WHERE subject LIKE 'Sign-in emails today:%'").bind().first()).toEqual({ n: 0 });
  });
});
