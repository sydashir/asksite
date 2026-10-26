import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORDER_INSERT_SQL } from "../src/order-sql.ts";
import { sitesHarness, type ToolsEnv } from "./support/harness.ts";

// D1 bills every row a query scans. Every count insertOrder's one statement makes must read an index of 0012, never the
// whole orders table: the global email count reads the partial index orders_emailed (its WHERE copies the index's), the
// per-network count orders_network, the repeat check orders_cart, the site's counts orders_site. Asked of the real database.

const h = sitesHarness();
let tools: ToolsEnv;
beforeAll(async () => {
  ({ tools } = await h.start());
}, 120_000);
afterAll(async () => {
  await h.server.close();
});

async function plan(): Promise<string[]> {
  const { results } = await tools.DB.prepare(`EXPLAIN QUERY PLAN ${ORDER_INSERT_SQL}`).bind(...Array.from({ length: 23 }, () => 0)).all<{ detail: string }>();
  return results.map((row) => row.detail);
}

describe("insertOrder's query plan (migration 0012)", () => {
  it("reads orders only through its indexes: never a full scan of orders", async () => {
    const lines = await plan();
    expect(lines.filter((line) => /\bSCAN orders\b/.test(line) && !/USING (COVERING )?INDEX/.test(line))).toEqual([]);
  });

  it("counts tried order emails through orders_emailed, networks through orders_network and repeats through orders_cart", async () => {
    const lines = (await plan()).join("\n");
    expect(lines).toMatch(/USING (COVERING )?INDEX orders_emailed\b/);
    expect(lines).toMatch(/USING (COVERING )?INDEX orders_network\b/);
    expect(lines).toMatch(/USING (COVERING )?INDEX orders_cart\b/);
    expect(lines).toMatch(/USING (COVERING )?INDEX orders_site\b/);
  });
});
