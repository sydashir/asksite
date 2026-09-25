import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { createMailer, LogMailer, MailerError, type OutgoingEmail } from "../src/index.ts";

const server = createTestHarness({
  root: resolve(import.meta.dirname, "../../.."),
  workers: [
    {
      config: {
        name: "mailer-log-test",
        main: "packages/core/test/support/noop-worker.ts",
        compatibility_date: "2026-09-21",
        d1_databases: [{ binding: "DB", database_name: "asksite", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "packages/core/migrations" }],
      },
    },
  ],
});
let DB: D1Database;

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  DB = (await worker.getEnv()).DB;
}, 120_000);
afterAll(async () => {
  await server.close();
});

const EMAIL: OutgoingEmail = {
  to: "owner@example.com",
  subject: "New request\r\nfrom your website",
  text: "Name: Dana",
  html: "<p>Name: Dana</p>",
  tag: "lead",
  idempotencyKey: "lead:1",
};

describe("LogMailer", () => {
  it("writes the email to dev_outbox with a cleaned subject", async () => {
    const { id } = await new LogMailer(DB, "development").send(EMAIL);
    expect(id).toMatch(/^log:\d+$/);
    const row = await DB.prepare("SELECT to_addr, subject, text, tag FROM dev_outbox ORDER BY id DESC LIMIT 1").first();
    expect(row).toEqual({ to_addr: "owner@example.com", subject: "New requestfrom your website", text: "Name: Dana", tag: "lead" });
  });

  it("refuses to run unless ENVIRONMENT is exactly development, so a typo fails closed", async () => {
    for (const environment of ["production", "prod", "", "Development"]) {
      await expect(new LogMailer(DB, environment).send(EMAIL)).rejects.toMatchObject({ code: "misconfigured" });
    }
  });
});

describe("createMailer", () => {
  it("returns the log mailer for MAILER=log", async () => {
    const mailer = createMailer({ MAILER: "log", MAIL_FROM: "a@b.example", DB, ENVIRONMENT: "development" });
    expect(mailer).toBeInstanceOf(LogMailer);
  });

  it("fails closed on an unknown MAILER value", async () => {
    const mailer = createMailer({ MAILER: "smtp" as "log", MAIL_FROM: "a@b.example", DB, ENVIRONMENT: "development" });
    const error = await mailer.send(EMAIL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailerError);
    expect((error as MailerError).code).toBe("misconfigured");
  });

  it("uses Resend for MAILER=resend and is misconfigured without a key", async () => {
    const mailer = createMailer({ MAILER: "resend", MAIL_FROM: "a@b.example", DB, ENVIRONMENT: "production" });
    await expect(mailer.send(EMAIL)).rejects.toMatchObject({ code: "misconfigured" });
  });
});
