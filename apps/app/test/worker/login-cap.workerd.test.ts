import { readFileSync } from "node:fs";
import { LIMITS, utcDayStart } from "@asksite/core";
import { afterEach, describe, expect, it } from "vitest";
import { awayFromUtcHourEnd, useAppHarness } from "../support/harness.ts";

// A11: every sign-in email of a UTC day, for all owners, is counted exactly in D1 (login_tokens created
// since 00:00 UTC, except kept links whose send ended "unavailable", B1-15). Controlled time: the Worker's clock is real, and each test places the rows it needs
// before or after the day's first millisecond. Its own file, so the day's count starts from a fresh D1.
const h = useAppHarness();

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// No test's login emails count toward the next test's caps, even when it fails halfway.
afterEach(h.clearLoginTokens);

/** LOGIN_EMAILS_PER_DAY in the test Worker's config (test/wrangler.test.jsonc, plain JSON). */
const LOGIN_EMAILS_PER_DAY = Number(
  (JSON.parse(readFileSync(new URL("../wrangler.test.jsonc", import.meta.url), "utf8")) as { vars: Record<string, string> }).vars["LOGIN_EMAILS_PER_DAY"],
);

async function outbox(email: string): Promise<unknown[]> {
  const { results } = await (await h.db()).prepare("SELECT subject FROM dev_outbox WHERE to_addr = ?").bind(email).all();
  return results;
}

async function tokenCount(ownerId: string): Promise<number> {
  return (await (await h.db()).prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE owner_id = ?").bind(ownerId).first<{ n: number }>())?.n ?? 0;
}

/** Waits out the last 10 s of a UTC day, so every request of a test falls in the day it computed. Returns that day's start. */
async function awayFromUtcMidnight(): Promise<number> {
  const left = utcDayStart(Date.now()) + DAY_MS - Date.now();
  if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 1_000));
  return utcDayStart(Date.now());
}

/** Adds login emails at the day's first millisecond (it counts) until the day holds `total`. */
async function fillDay(ownerId: string, dayStart: number, total: number): Promise<void> {
  const db = await h.db();
  const sent = (await db.prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE created_at >= ?").bind(dayStart).first<{ n: number }>())?.n ?? 0;
  for (let i = sent; i < total; i += 1) {
    await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(`filler-${crypto.randomUUID()}`, ownerId, dayStart, dayStart + 1).run();
  }
}

/** Adds `count` of the owner's login emails, all created at `at`. */
async function addTokens(ownerId: string, count: number, at: number): Promise<void> {
  const db = await h.db();
  for (let i = 0; i < count; i += 1) {
    await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(`earlier-${crypto.randomUUID()}`, ownerId, at, at + 1).run();
  }
}

/** Adds `count` of the owner's links, all created at `at`, kept after a send that ended "unavailable" and marked failed at `at` (B1-15). */
async function addFailedSends(ownerId: string, count: number, at: number): Promise<void> {
  const db = await h.db();
  for (let i = 0; i < count; i += 1) {
    await db
      .prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at, send_failed_at) VALUES (?, ?, ?, ?, ?)")
      .bind(`failed-${crypto.randomUUID()}`, ownerId, at, at + 1, at)
      .run();
  }
}

/** The Worker's login_email_cap_reached lines since the last clearLogs. */
function capLines(): string[] {
  return h.server.getLogs().filter((entry) => entry.message.includes("login_email_cap_reached")).map((entry) => entry.message);
}

/** Requests a sign-in link for `email` and waits for the background work. */
async function requestLink(email: string): Promise<void> {
  expect((await h.login(email)).status).toBe(202);
  await h.backgroundDone("/api/auth/login");
}

/** The UTC day ends for every login email so far: each moves to the previous day's last millisecond. */
async function endDay(dayStart: number): Promise<void> {
  await (await h.db()).prepare("UPDATE login_tokens SET created_at = ? WHERE created_at >= ?").bind(dayStart - 1, dayStart).run();
}

/** A response as the client sees it, except its Date header. */
async function answer(res: Response) {
  const headers = [...res.headers].filter(([name]) => name.toLowerCase() !== "date").sort(([a], [b]) => a.localeCompare(b));
  return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
}

describe("the daily cap on sign-in emails for all owners (A11)", () => {
  it(`sends the ${LOGIN_EMAILS_PER_DAY}th of a UTC day but not the next, still answering 202, and sends again the next day`, async () => {
    expect(LOGIN_EMAILS_PER_DAY).toBe(40);
    const filler = await h.signIn();
    const last = await h.signIn("fortieth@example.com");
    const over = await h.signIn("forty-first@example.com");
    const dayStart = await awayFromUtcMidnight();
    await fillDay(filler.ownerId, dayStart, LOGIN_EMAILS_PER_DAY - 1);

    await h.login(last.email);
    await h.backgroundDone("/api/auth/login");
    expect(await tokenCount(last.ownerId)).toBe(1);
    expect(await outbox(last.email)).toHaveLength(1);

    h.server.clearLogs();
    const res = await h.login(over.email);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    await h.backgroundDone("/api/auth/login");
    expect(await tokenCount(over.ownerId)).toBe(0);
    expect(await outbox(over.email)).toEqual([]);
    const capLines = h.server.getLogs().filter((entry) => entry.message.includes("login_email_cap_reached"));
    expect(capLines.map((entry) => entry.message)).toEqual(['{"event":"login_email_cap_reached"}']);

    await endDay(dayStart);
    await h.login(over.email);
    await h.backgroundDone("/api/auth/login");
    expect(await tokenCount(over.ownerId)).toBe(1);
    expect(await outbox(over.email)).toHaveLength(1);
  });
});

// B1-15: during an email outage the owner app keeps each link whose send ended "unavailable" (F26) and marks it. The day's
// cap for all owners skips marked links, so retries in an outage cannot pause sign-in emails for every owner; each
// owner's own caps still count them, so one inbox stays bounded if the provider delivered after all.
describe("links kept after an unavailable send and the day's cap for all owners (B1-15)", () => {
  it(`still sends another owner a link when the day's ${LOGIN_EMAILS_PER_DAY} links all ended unavailable, and logs no cap line`, async () => {
    const outage = await h.signIn();
    const next = await h.signIn("after-the-outage@example.com");
    const dayStart = await awayFromUtcMidnight();
    await addFailedSends(outage.ownerId, LOGIN_EMAILS_PER_DAY, dayStart);
    h.server.clearLogs();
    await requestLink(next.email);
    expect(await tokenCount(next.ownerId)).toBe(1);
    expect(await outbox(next.email)).toHaveLength(1);
    expect(capLines()).toEqual([]);
  });

  it(`logs login_email_cap_reached only when the day's unmarked links reach ${LOGIN_EMAILS_PER_DAY}, not for marked ones`, async () => {
    const outage = await h.signIn();
    const capped = await h.signIn("capped-in-outage@example.com");
    const late = await h.signIn("late-in-the-day@example.com");
    const dayStart = await awayFromUtcMidnight();
    // Marked links only: the day's 40 plus the owner's own 5 this hour. The owner's hourly cap refuses the request,
    // and the day's count (the unmarked links) is 0, so no cap line.
    await addFailedSends(outage.ownerId, LOGIN_EMAILS_PER_DAY, dayStart);
    await addFailedSends(capped.ownerId, LIMITS.loginTokensPerOwnerPerHour, Date.now());
    h.server.clearLogs();
    await requestLink(capped.email);
    expect(await tokenCount(capped.ownerId)).toBe(LIMITS.loginTokensPerOwnerPerHour);
    expect(capLines()).toEqual([]);
    // 40 unmarked links as well: the next request is refused by the day's cap, and logged once.
    await addTokens(outage.ownerId, LOGIN_EMAILS_PER_DAY, dayStart);
    await requestLink(late.email);
    expect(await tokenCount(late.ownerId)).toBe(0);
    expect(await outbox(late.email)).toEqual([]);
    expect(capLines()).toEqual(['{"event":"login_email_cap_reached"}']);
  });

  it(`still counts them in the owner's ${LIMITS.loginTokensPerOwnerPerHour} links an hour`, async () => {
    const owner = await h.signIn();
    await addFailedSends(owner.ownerId, LIMITS.loginTokensPerOwnerPerHour, Date.now() - 60_000);
    await requestLink(owner.email);
    expect(await tokenCount(owner.ownerId)).toBe(LIMITS.loginTokensPerOwnerPerHour);
    expect(await outbox(owner.email)).toEqual([]);
  });

  it(`still counts them in the owner's ${LIMITS.loginTokensPerOwnerPerDay} links in 24 hours`, async () => {
    const owner = await h.signIn();
    // More than an hour ago (the hourly cap does not count them) and less than a day ago.
    await addFailedSends(owner.ownerId, LIMITS.loginTokensPerOwnerPerDay, Date.now() - 2 * HOUR_MS);
    await requestLink(owner.email);
    expect(await tokenCount(owner.ownerId)).toBe(LIMITS.loginTokensPerOwnerPerDay);
    expect(await outbox(owner.email)).toEqual([]);
  });
});

describe("sign-in answers say nothing about owners (§5.2)", () => {
  it("are byte for byte the same 202 for a known owner, an unknown address, a disabled owner, an owner at their cap and one past the daily cap", async () => {
    const known = await h.signIn("known-owner@example.com");
    const disabled = await h.signIn("disabled-owner@example.com");
    const capped = await h.signIn("capped-owner@example.com");
    const pastDay = await h.signIn("past-the-day@example.com");
    const db = await h.db();
    await db.prepare("UPDATE owners SET disabled_at = 1 WHERE id = ?").bind(disabled.ownerId).run();
    const dayStart = await awayFromUtcMidnight();
    const now = Date.now();
    for (let i = 0; i < LIMITS.loginTokensPerOwnerPerHour; i += 1) {
      await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(`capped-${i}`, capped.ownerId, now, now + 1).run();
    }

    const answers = [];
    for (const email of [known.email, "nobody-here@example.com", disabled.email, capped.email]) answers.push(await answer(await h.login(email)));
    await h.backgroundDone("/api/auth/login");
    await fillDay(known.ownerId, dayStart, LOGIN_EMAILS_PER_DAY);
    answers.push(await answer(await h.login(pastDay.email)));
    await h.backgroundDone("/api/auth/login");

    // Each case took its own path after the answer...
    expect(await outbox(known.email)).toHaveLength(1);
    // Open self sign-up (DECIDED 2026-10-07): the unknown address gets the sign-up email, not a sign-in link.
    expect(await outbox("nobody-here@example.com")).toEqual([{ subject: "Set up your business website" }]);
    expect(await tokenCount(disabled.ownerId)).toBe(0);
    expect(await tokenCount(capped.ownerId)).toBe(LIMITS.loginTokensPerOwnerPerHour);
    expect(await tokenCount(pastDay.ownerId)).toBe(0);
    // ...and every answer is the same.
    expect(answers[0]?.status).toBe(202);
    expect(new TextDecoder().decode(answers[0]?.body)).toBe('{"ok":true}');
    for (const other of answers.slice(1)) expect(other).toEqual(answers[0]);
  });
});

// Design §5.2: each owner gets at most 5 links in any hour and 10 in any 24 hours, counted back from the
// request, never from the start of a UTC day or clock hour. Controlled time: the Worker's clock is real,
// so each test places the earlier links just before the day or hour it is in.
describe("the per-owner sign-in link caps are rolling windows (§5.2)", () => {
  it("counts links from before 00:00 UTC in the 10 per 24 hours", async () => {
    const owner = await h.signIn();
    await awayFromUtcHourEnd();
    const now = Date.now();
    // Nine links on the previous UTC day, but less than a day ago and more than an hour ago (so the
    // hourly cap does not count them).
    const lateYesterday = Math.min(utcDayStart(now), now - HOUR_MS) - 1_000;
    await addTokens(owner.ownerId, 9, lateYesterday);
    await requestLink(owner.email);
    expect(await tokenCount(owner.ownerId)).toBe(10);
    expect(await outbox(owner.email)).toHaveLength(1);
    await requestLink(owner.email);
    expect(await tokenCount(owner.ownerId)).toBe(10);
    expect(await outbox(owner.email)).toHaveLength(1);
  });

  it("counts links from before the current UTC hour in the 5 per hour", async () => {
    const owner = await h.signIn();
    await awayFromUtcHourEnd();
    const now = Date.now();
    // Four links in the previous clock hour, but less than an hour ago.
    const lastHour = now - (now % HOUR_MS) - 1_000;
    await addTokens(owner.ownerId, 4, lastHour);
    await requestLink(owner.email);
    expect(await tokenCount(owner.ownerId)).toBe(5);
    expect(await outbox(owner.email)).toHaveLength(1);
    await requestLink(owner.email);
    expect(await tokenCount(owner.ownerId)).toBe(5);
    expect(await outbox(owner.email)).toHaveLength(1);
  });
});
