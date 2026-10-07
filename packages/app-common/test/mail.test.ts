import { describe, expect, it, vi } from "vitest";
import { sendReporting, trySend, type Mailer, type OutgoingEmail } from "../src/mail.ts";

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

/** Calls sendReporting with console.log captured; returns what it reported and the raw log lines. */
async function report(mailer: Mailer): Promise<{ failure: string | null; lines: string[] }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const failure = await sendReporting(mailer, EMAIL);
    return { failure, lines: log.mock.calls.map(([line]) => String(line)) };
  } finally {
    log.mockRestore();
  }
}

/** The one line a failed send writes, byte for byte as logLine writes it. */
const failedLine = (error: string): string => JSON.stringify({ event: "email_failed", tag: "magic_link", error });

describe("sendReporting", () => {
  it("returns null and logs nothing when the email is sent", async () => {
    expect(await report({ send: async () => ({ id: "m1" }) })).toEqual({ failure: null, lines: [] });
  });

  it.each<MailerCode>(["rate_limited", "rejected", "unavailable", "misconfigured"])("returns the mailer's code %s and logs it once", async (code) => {
    const thrown = new MailerError(code, `Resend refused ${EMAIL.to} (key re_live_SECRET)`);
    expect(await report(failing(thrown))).toEqual({ failure: code, lines: [failedLine(code)] });
  });

  it("reads the code structurally, from any thrown value that carries one of the four", async () => {
    expect(await report(failing({ code: "unavailable", message: "down" }))).toEqual({ failure: "unavailable", lines: [failedLine("unavailable")] });
  });

  it("returns the class name of any other Error, even one with some other code", async () => {
    for (const [thrown, name] of [
      [new TypeError("fetch failed"), "TypeError"],
      [Object.assign(new RangeError("socket"), { code: "ECONNRESET" }), "RangeError"],
    ] as const) {
      expect(await report(failing(thrown))).toEqual({ failure: name, lines: [failedLine(name)] });
    }
  });

  it('returns "unknown" for a thrown value that is not an Error and carries no mailer code', async () => {
    for (const thrown of ["owner@private.example", null, undefined, { code: "ECONNRESET" }]) {
      expect(await report(failing(thrown))).toEqual({ failure: "unknown", lines: [failedLine("unknown")] });
    }
  });

  it("never returns or logs the address, subject, body, key or error message", async () => {
    const seen: string[] = [];
    for (const thrown of [new MailerError("rejected", `Resend refused ${EMAIL.to} (key re_live_SECRET)`), new Error(EMAIL.to), EMAIL.to]) {
      const { failure, lines } = await report(failing(thrown));
      seen.push(String(failure), ...lines);
    }
    expect(seen).toHaveLength(6);
    for (const secret of [EMAIL.to, EMAIL.subject, "TOKENTOKENTOKEN", "re_live_SECRET", "Resend refused"]) {
      expect(seen.join("\n")).not.toContain(secret);
    }
  });

  it("is what trySend wraps: for the same failure, trySend logs the same single line, byte for byte", async () => {
    for (const thrown of [new MailerError("rate_limited", "quota"), new TypeError("fetch failed"), null]) {
      const wrapped = await attempt(failing(thrown));
      const reported = await report(failing(thrown));
      expect(wrapped).toEqual({ sent: false, lines: reported.lines });
      expect(reported.lines).toHaveLength(1);
    }
    expect(await attempt({ send: async () => ({ id: "m2" }) })).toEqual({ sent: true, lines: [] });
  });
});

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
