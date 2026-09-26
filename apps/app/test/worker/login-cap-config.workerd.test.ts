import { utcDayStart } from "@asksite/core";
import { afterEach, describe, expect, it } from "vitest";
import { awayFromUtcHourEnd, useAppHarness } from "../support/harness.ts";

// LOGIN_EMAILS_PER_DAY is read as a whole number above 0; anything else is logged once and the default,
// 40, applies (A11; login-emails-per-day.test.ts covers every invalid form). Each value runs its own
// Worker, with its own fresh D1, because the value is part of the Worker's configuration.

type Harness = ReturnType<typeof useAppHarness>;

async function tokenCount(h: Harness, ownerId: string): Promise<number> {
  return (await (await h.db()).prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE owner_id = ?").bind(ownerId).first<{ n: number }>())?.n ?? 0;
}

async function emailCount(h: Harness, email: string): Promise<number> {
  return (await (await h.db()).prepare("SELECT COUNT(*) AS n FROM dev_outbox WHERE to_addr = ?").bind(email).first<{ n: number }>())?.n ?? 0;
}

/** Signs `email` in by link request and waits for the background work. */
async function requestLink(h: Harness, email: string): Promise<void> {
  expect((await h.login(email)).status).toBe(202);
  await h.backgroundDone("/api/auth/login");
}

const events = (h: Harness, event: string): unknown[] => h.logLines().filter((line) => line["event"] === event);

/** No login email of one test counts toward the next test's day. */
function cleanUpAfterEach(h: Harness): void {
  afterEach(async () => {
    await h.backgroundDone("/api/auth/login");
    await (await h.db()).prepare("DELETE FROM login_tokens").bind().run();
  });
}

describe("a valid LOGIN_EMAILS_PER_DAY", () => {
  const h = useAppHarness({ vars: { LOGIN_EMAILS_PER_DAY: "2" } });
  cleanUpAfterEach(h);

  it("is the day's cap for all owners, with nothing logged about the value", async () => {
    const owners = [await h.signIn(), await h.signIn(), await h.signIn()];
    await awayFromUtcHourEnd();
    h.server.clearLogs();
    for (const owner of owners) await requestLink(h, owner.email);
    expect(await Promise.all(owners.map((owner) => tokenCount(h, owner.ownerId)))).toEqual([1, 1, 0]);
    expect(await Promise.all(owners.map((owner) => emailCount(h, owner.email)))).toEqual([1, 1, 0]);
    expect(events(h, "login_email_cap_reached")).toHaveLength(1);
    expect(events(h, "config_invalid")).toEqual([]);
  });
});

describe("an invalid LOGIN_EMAILS_PER_DAY", () => {
  const h = useAppHarness({ vars: { LOGIN_EMAILS_PER_DAY: "0" } });
  cleanUpAfterEach(h);

  it("is logged as config_invalid, never its value, and the default of 40 a day applies", async () => {
    const first = await h.signIn();
    const past = await h.signIn();
    await awayFromUtcHourEnd();
    h.server.clearLogs();
    await requestLink(h, first.email);
    expect(await tokenCount(h, first.ownerId)).toBe(1);
    expect(await emailCount(h, first.email)).toBe(1);
    expect(events(h, "config_invalid")).toEqual([{ event: "config_invalid", variable: "LOGIN_EMAILS_PER_DAY" }]);

    // Fill the day to 40 at its first millisecond: the next owner's link is past the default cap.
    const db = await h.db();
    const dayStart = utcDayStart(Date.now());
    for (let i = 1; i < 40; i += 1) {
      await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(`filler-${i}`, first.ownerId, dayStart, dayStart + 1).run();
    }
    await requestLink(h, past.email);
    expect(await tokenCount(h, past.ownerId)).toBe(0);
    expect(await emailCount(h, past.email)).toBe(0);
    expect(events(h, "login_email_cap_reached")).toHaveLength(1);
    expect(events(h, "config_invalid")).toHaveLength(2);
  });
});
