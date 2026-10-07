import { ApiError } from "@asksite/app-common";
import { Hono } from "hono";
import type { AppEnv } from "../types.ts";

/** Development only: the emails the log mailer wrote. Answers 404 everywhere else (§4.4). */
export function devRoutes(): Hono<AppEnv> {
  const dev = new Hono<AppEnv>();
  dev.get("/dev/outbox", async (c) => {
    const host = new URL(c.req.url).hostname;
    if (c.env.ENVIRONMENT !== "development" || !(host === "localhost" || host.endsWith(".localhost"))) {
      throw new ApiError("not_found", "Not found");
    }
    const to = (c.req.query("to") ?? "").trim().toLowerCase();
    const { results } = await c.env.DB.prepare(
      "SELECT at, to_addr AS \"to\", subject, text, tag FROM dev_outbox WHERE to_addr = ? ORDER BY id DESC LIMIT 50",
    )
      .bind(to)
      .all();
    return c.json({ messages: results });
  });
  return dev;
}
