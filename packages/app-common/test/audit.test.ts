import { describe, expect, it } from "vitest";
import { auditStatement } from "../src/audit.ts";

describe("auditStatement", () => {
  it("binds the row in column order with the detail as JSON", () => {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const db = { prepare: (query: string) => ({ bind: (...values: unknown[]) => calls.push({ query, values }) }) };
    auditStatement(db, { at: 5, actor: "admin:a@example.com", action: "site.taken_down", siteId: "s1", detail: { reason: "phishing" } });
    auditStatement(db, { at: 6, actor: "system", action: "settings.updated", siteId: null });
    expect(calls).toEqual([
      { query: "INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, ?, ?, ?, ?)", values: [5, "admin:a@example.com", "site.taken_down", "s1", '{"reason":"phishing"}'] },
      { query: "INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, ?, ?, ?, ?)", values: [6, "system", "settings.updated", null, null] },
    ]);
  });
});
