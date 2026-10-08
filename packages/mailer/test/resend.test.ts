import { describe, expect, it } from "vitest";
import { MailerError, ResendMailer, type OutgoingEmail } from "../src/index.ts";

const KEY = "re_test_not_a_real_key";
const EMAIL: OutgoingEmail = {
  to: "owner@example.com",
  subject: "New request from your website: Dana",
  text: "Hello",
  html: "<p>Hello</p>",
  replyTo: "dana@example.com",
  tag: "lead",
  idempotencyKey: "lead:7c9e6679-7425-40de-944b-e07fc1f90ae7",
};

interface Captured { url: string; init: RequestInit }

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, fn };
}

async function failure(mailer: ResendMailer, email: OutgoingEmail = EMAIL): Promise<MailerError> {
  try {
    await mailer.send(email);
  } catch (error) {
    if (error instanceof MailerError) return error;
    throw error;
  }
  throw new Error("send did not fail");
}

describe("ResendMailer", () => {
  it("posts the documented request and returns Resend's id", async () => {
    const fake = fakeFetch(() => Response.json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }));
    const mailer = new ResendMailer(KEY, "asksite <leads@mail.asksite.example>", fake.fn);
    expect(await mailer.send(EMAIL)).toEqual({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call?.url).toBe("https://api.resend.com/emails");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": EMAIL.idempotencyKey,
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      from: "asksite <leads@mail.asksite.example>",
      to: ["owner@example.com"],
      subject: EMAIL.subject,
      html: EMAIL.html,
      text: EMAIL.text,
      reply_to: "dana@example.com",
    });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves reply_to out when there is none", async () => {
    const fake = fakeFetch(() => Response.json({ id: "x" }));
    const { replyTo: _dropped, ...noReply } = EMAIL;
    await new ResendMailer(KEY, "a@b.example", fake.fn).send(noReply);
    expect(JSON.parse(String(fake.calls[0]?.init.body))).not.toHaveProperty("reply_to");
  });

  it("strips CR, LF and other control characters from the subject", async () => {
    const fake = fakeFetch(() => Response.json({ id: "x" }));
    await new ResendMailer(KEY, "a@b.example", fake.fn).send({ ...EMAIL, subject: "Hi\r\nBcc: victim@example.com\u0007" });
    expect(JSON.parse(String(fake.calls[0]?.init.body)).subject).toBe("HiBcc: victim@example.com");
  });

  it("refuses an address with a line break before calling Resend", async () => {
    const fake = fakeFetch(() => Response.json({ id: "x" }));
    const error = await failure(new ResendMailer(KEY, "a@b.example", fake.fn), { ...EMAIL, replyTo: "a@b.example\r\nBcc: x@y.example" });
    expect(error.code).toBe("rejected");
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    [429, "rate_limited"],
    [400, "rejected"],
    [403, "rejected"],
    [422, "rejected"],
    [500, "unavailable"],
    [503, "unavailable"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ message: "owner@example.com is invalid" }), { status }));
    const error = await failure(new ResendMailer(KEY, "a@b.example", fake.fn));
    expect(error.code).toBe(code);
    expect(error.message).toBe(`Resend returned ${status}`);
  });

  it("maps a network failure or timeout to unavailable", async () => {
    const error = await failure(new ResendMailer(KEY, "a@b.example", () => Promise.reject(new DOMException("timed out", "TimeoutError"))));
    expect(error.code).toBe("unavailable");
  });

  it("treats a 2xx without an id as unavailable", async () => {
    const error = await failure(new ResendMailer(KEY, "a@b.example", fakeFetch(() => new Response("{}")).fn));
    expect(error.code).toBe("unavailable");
  });

  // C1 RULING 3 (2026-10-08): the lead-email retry takes a new idempotency key only after Resend answered 429 or 5xx
  // (not sent), and keeps the key when there was no answer (the email may have gone out). So an error says whether,
  // and how, Resend answered.
  it.each([429, 400, 403, 409, 422, 500, 503])("records Resend's HTTP status %i on the error", async (status) => {
    const error = await failure(new ResendMailer(KEY, "a@b.example", fakeFetch(() => new Response("{}", { status })).fn));
    expect(error.status).toBe(status);
  });

  it("records no status when Resend gave no answer, and the 2xx status of an answer with no id", async () => {
    expect((await failure(new ResendMailer(KEY, "a@b.example", () => Promise.reject(new TypeError("network"))))).status).toBeUndefined();
    expect((await failure(new ResendMailer(KEY, "a@b.example", fakeFetch(() => new Response("{}", { status: 202 })).fn))).status).toBe(202);
  });

  it("reads the error name from a refusal's body, and never its message", async () => {
    const answer = (body: string) => fakeFetch(() => new Response(body, { status: 409 })).fn;
    const concurrent = await failure(new ResendMailer(KEY, "a@b.example", answer(JSON.stringify({ statusCode: 409, name: "concurrent_idempotent_requests", message: "owner@example.com" }))));
    expect(concurrent).toMatchObject({ code: "rejected", status: 409, reason: "concurrent_idempotent_requests" });
    expect(concurrent.message).toBe("Resend returned 409");
    expect((await failure(new ResendMailer(KEY, "a@b.example", answer("not json")))).reason).toBeUndefined();
    expect((await failure(new ResendMailer(KEY, "a@b.example", answer(JSON.stringify({ name: 7 }))))).reason).toBeUndefined();
  });

  it("is misconfigured without a key or sender, and never calls Resend", async () => {
    const fake = fakeFetch(() => Response.json({ id: "x" }));
    expect((await failure(new ResendMailer("", "a@b.example", fake.fn))).code).toBe("misconfigured");
    expect((await failure(new ResendMailer(KEY, "", fake.fn))).code).toBe("misconfigured");
    expect(fake.calls).toHaveLength(0);
  });

  it("never puts the key, the recipient or Resend's reply into an error message", async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ message: "owner@example.com rejected" }), { status: 422 }));
    const error = await failure(new ResendMailer(KEY, "a@b.example", fake.fn));
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain("owner@example.com");
  });
});
