import { readFileSync } from "node:fs";
import { LIMITS, utcDayStart } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { useAppHarness } from "../support/harness.ts";

// A11: every sign-in email of a UTC day, for all owners, is counted exactly in D1 (login_tokens created
// since 00:00 UTC). Controlled time: the Worker's clock is real, and each test places the rows it needs
// before or after the day's first millisecond. Its own file, so the day's count starts from a fresh D1.
const h = useAppHarness();

const DAY_MS = 86_400_000;

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
    expect(await outbox("nobody-here@example.com")).toEqual([]);
    expect(await tokenCount(disabled.ownerId)).toBe(0);
    expect(await tokenCount(capped.ownerId)).toBe(LIMITS.loginTokensPerOwnerPerHour);
    expect(await tokenCount(pastDay.ownerId)).toBe(0);
    // ...and every answer is the same.
    expect(answers[0]?.status).toBe(202);
    expect(new TextDecoder().decode(answers[0]?.body)).toBe('{"ok":true}');
    for (const other of answers.slice(1)) expect(other).toEqual(answers[0]);
    await endDay(dayStart);
  });
});
