import { describe, expect, it, vi } from "vitest";
import { trySend, type Mailer, type OutgoingEmail } from "../src/mail.ts";

const EMAIL: OutgoingEmail = {
  to: "owner@private.example",
  subject: "Your sign-in link",
  text: "Sign in: https://app.asksite.example/login#TOKENTOKENTOKEN",
  html: "<p>TOKENTOKENTOKEN</p>",
  tag: "magic_link",
  idempotencyKey: "login:abc",
};

type MailerCode = "rate_limited" | "rejected" | "unavailable" | "misconfigured";

/** Plan 2's MailerError as design §7.6 writes it (restated: @asksite/mailer is not merged), without the
 *  parameter property that erasableSyntaxOnly forbids. Like the design's, it keeps Error's name. */
class MailerError extends Error {
  readonly code: MailerCode;

  constructor(code: MailerCode, message: string) {
    super(message);
    this.code = code;
  }
}

const failing = (thrown: unknown): Mailer => ({
  send: async () => {
    throw thrown;
  },
});

/** Calls trySend with console.log captured; returns its result and the raw log lines. */
async function attempt(mailer: Mailer): Promise<{ sent: boolean; lines: string[] }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const sent = await trySend(mailer, EMAIL);
    return { sent, lines: log.mock.calls.map(([line]) => String(line)) };
  } finally {
    log.mockRestore();
  }
}

describe("trySend", () => {
  it("returns true and logs nothing when the email is sent", async () => {
    expect(await attempt({ send: async () => ({ id: "m1" }) })).toEqual({ sent: true, lines: [] });
  });

  it.each<MailerCode>(["rate_limited", "rejected", "unavailable", "misconfigured"])("returns false and logs the mailer's code %s", async (code) => {
    const { sent, lines } = await attempt(failing(new MailerError(code, `Resend refused ${EMAIL.to} (key re_live_SECRET)`)));
    expect(sent).toBe(false);
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ event: "email_failed", tag: "magic_link", error: code }]);
  });

  it("reads the code structurally, from any thrown value that carries one of the four", async () => {
    const { lines } = await attempt(failing({ code: "unavailable", message: "down" }));
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ event: "email_failed", tag: "magic_link", error: "unavailable" }]);
  });

  it("logs the class name of any other Error, even one with some other code", async () => {
    for (const [thrown, name] of [
      [new TypeError("fetch failed"), "TypeError"],
      [Object.assign(new RangeError("socket"), { code: "ECONNRESET" }), "RangeError"],
    ] as const) {
      const { sent, lines } = await attempt(failing(thrown));
      expect(sent).toBe(false);
      expect(lines.map((line) => JSON.parse(line))).toEqual([{ event: "email_failed", tag: "magic_link", error: name }]);
    }
  });

  it('logs "unknown" for a thrown value that is not an Error and carries no mailer code', async () => {
    for (const thrown of ["owner@private.example", null, undefined, { code: "ECONNRESET" }]) {
      const { sent, lines } = await attempt(failing(thrown));
      expect(sent).toBe(false);
      expect(lines.map((line) => JSON.parse(line))).toEqual([{ event: "email_failed", tag: "magic_link", error: "unknown" }]);
    }
  });

  it("never logs the address, subject, body, key or error message", async () => {
    const lines: string[] = [];
    for (const thrown of [new MailerError("rejected", `Resend refused ${EMAIL.to} (key re_live_SECRET)`), new Error(EMAIL.to), EMAIL.to]) {
      lines.push(...(await attempt(failing(thrown))).lines);
    }
    expect(lines).toHaveLength(3);
    for (const secret of [EMAIL.to, EMAIL.subject, "TOKENTOKENTOKEN", "re_live_SECRET", "Resend refused"]) {
      expect(lines.join("\n")).not.toContain(secret);
    }
  });
});
