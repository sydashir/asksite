import type { LeadView } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { json, useAppHarness } from "../support/harness.ts";

const h = useAppHarness();

async function addLead(siteId: string, createdAt: number, extra: { spam?: 0 | 1; name?: string } = {}) {
  await (await h.db())
    .prepare(
      `INSERT INTO leads (id, site_id, created_at, name, phone, email, service, message, spam, email_status, ip_hash)
       VALUES (?, ?, ?, ?, '(512) 555-0199', NULL, 'Drain cleaning', 'Kitchen sink is slow', ?, 'sent', 'hash')`,
    )
    .bind(crypto.randomUUID(), siteId, createdAt, extra.name ?? `Lead ${createdAt}`, extra.spam ?? 0)
    .run();
}

describe("GET /api/sites/:siteId/leads", () => {
  it("pages newest first and hides spam", async () => {
    const owner = await h.signIn();
    for (let t = 1; t <= 5; t += 1) await addLead(owner.siteId, t * 1000);
    await addLead(owner.siteId, 6000, { spam: 1, name: "Spammer" });
    const page1 = await json<{ leads: LeadView[]; nextBefore: number | null }>(
      await h.call("GET", `/api/sites/${owner.siteId}/leads?limit=2`, { cookie: owner.cookie }),
    );
    expect(page1.leads.map((l) => l.createdAt)).toEqual([5000, 4000]);
    expect(page1.nextBefore).toBe(4000);
    expect(page1.leads[0]).toEqual({
      id: page1.leads[0]?.id,
      createdAt: 5000,
      name: "Lead 5000",
      phone: "(512) 555-0199",
      email: null,
      service: "Drain cleaning",
      message: "Kitchen sink is slow",
      emailStatus: "sent",
    });
    const page3 = await json<{ leads: LeadView[]; nextBefore: number | null }>(
      await h.call("GET", `/api/sites/${owner.siteId}/leads?limit=2&before=2000`, { cookie: owner.cookie }),
    );
    expect(page3).toMatchObject({ nextBefore: null });
    expect(page3.leads.map((l) => l.createdAt)).toEqual([1000]);
  });

  it("never splits the leads of one millisecond across two pages (decision 35)", async () => {
    const owner = await h.signIn();
    for (const [createdAt, name] of [[5000, "A"], [5000, "B"], [5000, "C"], [3000, "D"], [1000, "E"]] as const) await addLead(owner.siteId, createdAt, { name });
    type Page = { leads: LeadView[]; nextBefore: number | null };
    const page1 = await json<Page>(await h.call("GET", `/api/sites/${owner.siteId}/leads?limit=2`, { cookie: owner.cookie }));
    expect(page1.leads.map((l) => l.createdAt)).toEqual([5000, 5000, 5000]);
    expect(page1.nextBefore).toBe(5000);
    const page2 = await json<Page>(await h.call("GET", `/api/sites/${owner.siteId}/leads?limit=2&before=5000`, { cookie: owner.cookie }));
    expect(page2.leads.map((l) => l.name)).toEqual(["D", "E"]);
    expect(page2.nextBefore).toBeNull();

    const tied = await h.signIn();
    for (const name of ["X", "Y", "Z"]) await addLead(tied.siteId, 7000, { name });
    const only = await json<Page>(await h.call("GET", `/api/sites/${tied.siteId}/leads?limit=2`, { cookie: tied.cookie }));
    expect(only.leads.map((l) => l.name).sort()).toEqual(["X", "Y", "Z"]);
    expect(only.nextBefore).toBeNull();
  });

  it("keeps spam hidden when a page takes its whole last millisecond (D5, decision 35)", async () => {
    const owner = await h.signIn();
    for (const [createdAt, name] of [[5000, "A"], [5000, "B"], [5000, "C"], [3000, "D"]] as const) await addLead(owner.siteId, createdAt, { name });
    await addLead(owner.siteId, 5000, { spam: 1, name: "Spammer" });
    const page1 = await json<{ leads: LeadView[]; nextBefore: number | null }>(
      await h.call("GET", `/api/sites/${owner.siteId}/leads?limit=2`, { cookie: owner.cookie }),
    );
    expect(page1.leads.map((l) => l.name).sort()).toEqual(["A", "B", "C"]);
    expect(page1.nextBefore).toBe(5000);
  });

  // C1: while the sites Worker's */15 cron re-sends a lead's email it holds the lead as pending, with email_error
  // 'retrying:<ms>'. The view carries email_status only, and the red "We could not email you" line shows only for
  // failed, so the owner sees a lead on its way, never an error.
  it("shows a lead the lead-email retry has claimed as pending", async () => {
    const owner = await h.signIn();
    await (await h.db())
      .prepare(
        `INSERT INTO leads (id, site_id, created_at, name, phone, email, service, message, spam, email_status, email_error, ip_hash)
         VALUES (?, ?, 3000, 'Claimed', '(512) 555-0199', NULL, NULL, NULL, 0, 'pending', 'retrying:1759924800000', 'hash')`,
      )
      .bind(crypto.randomUUID(), owner.siteId)
      .run();
    const page = await json<{ leads: LeadView[] }>(await h.call("GET", `/api/sites/${owner.siteId}/leads`, { cookie: owner.cookie }));
    expect(page.leads).toHaveLength(1);
    expect(page.leads[0]).toMatchObject({ name: "Claimed", emailStatus: "pending" });
    expect(Object.keys(page.leads[0] ?? {})).not.toContain("emailError");
  });

  it("refuses a bad page size and another owner's leads", async () => {
    const a = await h.signIn();
    const b = await h.signIn();
    expect((await h.call("GET", `/api/sites/${a.siteId}/leads?limit=500`, { cookie: a.cookie })).status).toBe(400);
    expect((await h.call("GET", `/api/sites/${b.siteId}/leads`, { cookie: a.cookie })).status).toBe(404);
  });
});

describe("GET /api/dev/outbox", () => {
  it("lists what the log mailer sent to an address, newest first, in development on *.localhost", async () => {
    await (await h.db())
      .prepare("INSERT INTO dev_outbox (at, to_addr, subject, text, tag) VALUES (1, 'x@example.com', 'First', 'a', 'invite'), (2, 'x@example.com', 'Second', 'b', 'magic_link')")
      .bind()
      .run();
    const res = await h.call("GET", "/api/dev/outbox?to=X@example.com");
    expect(await res.json()).toEqual({
      messages: [
        { at: 2, to: "x@example.com", subject: "Second", text: "b", tag: "magic_link" },
        { at: 1, to: "x@example.com", subject: "First", text: "a", tag: "invite" },
      ],
    });
  });

  it("is 404 on a host that is not *.localhost", async () => {
    expect((await h.call("GET", "/api/dev/outbox?to=a@example.com")).status).toBe(200);
    const res = await h.server.fetch("https://app.asksite.example/api/dev/outbox?to=a@example.com");
    expect(res.status).toBe(404);
  });
});
