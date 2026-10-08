import { assertAddresses, cleanSubject, MailerError, type Mailer, type OutgoingEmail } from "./types.ts";

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Resend's HTTP API (POST /emails with an Idempotency-Key). Error messages carry only the HTTP
 * status, never the key, the recipient or Resend's response body.
 */
export class ResendMailer implements Mailer {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: Fetch;

  // The default is a wrapper, not a stored reference to `fetch`: calling a detached `fetch` with
  // the wrong `this` throws "Illegal invocation" in workerd.
  constructor(apiKey: string, from: string, fetchFn: Fetch = (input, init) => fetch(input, init)) {
    this.#apiKey = apiKey;
    this.#from = from;
    this.#fetch = fetchFn;
  }

  async send(email: OutgoingEmail): Promise<{ id: string }> {
    if (this.#apiKey === "" || this.#from === "") throw new MailerError("misconfigured", "RESEND_API_KEY and MAIL_FROM must be set");
    assertAddresses(email);
    const body = {
      from: this.#from,
      to: [email.to],
      subject: cleanSubject(email.subject),
      html: email.html,
      text: email.text,
      ...(email.replyTo === undefined ? {} : { reply_to: email.replyTo }),
    };

    let response: Response;
    try {
      response = await this.#fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new MailerError("unavailable", "Resend could not be reached");
    }

    if (response.status === 429) throw new MailerError("rate_limited", "Resend returned 429");
    if (response.status >= 400 && response.status < 500) throw new MailerError("rejected", `Resend returned ${response.status}`);
    if (!response.ok) throw new MailerError("unavailable", `Resend returned ${response.status}`);
    const result: unknown = await response.json().catch(() => null);
    const id = typeof result === "object" && result !== null && "id" in result ? result.id : undefined;
    if (typeof id !== "string") throw new MailerError("unavailable", "Resend returned no email id");
    return { id };
  }
}
