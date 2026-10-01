import { assertAddresses, cleanSubject, MailerError, type Mailer, type OutgoingEmail } from "./types.ts";

/** Development and test mailer: writes each email to the dev_outbox table. It runs only when ENVIRONMENT is
 *  exactly "development" (Decision 30), so a typo or an empty value can never store sign-in links in production. */
export class LogMailer implements Mailer {
  readonly #db: D1Database;
  readonly #environment: string;

  constructor(db: D1Database, environment: string) {
    this.#db = db;
    this.#environment = environment;
  }

  async send(email: OutgoingEmail): Promise<{ id: string }> {
    if (this.#environment !== "development") throw new MailerError("misconfigured", "The log mailer runs only when ENVIRONMENT is development");
    assertAddresses(email);
    const result = await this.#db
      .prepare("INSERT INTO dev_outbox (at, to_addr, subject, text, tag) VALUES (?, ?, ?, ?, ?)")
      .bind(Date.now(), email.to, cleanSubject(email.subject), email.text, email.tag)
      .run();
    return { id: `log:${result.meta.last_row_id}` };
  }
}
