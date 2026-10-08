export type EmailTag = "lead" | "magic_link" | "invite" | "review_result" | "site_notice" | "admin_alert" | "signup_invite"; // site_notice: takedown message to the owner

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  tag: EmailTag;
  idempotencyKey: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

export type MailerErrorCode = "rate_limited" | "rejected" | "unavailable" | "misconfigured";

// Written with an explicit field: the repo's tsconfig sets erasableSyntaxOnly, which forbids
// constructor parameter properties. The public shape is the design's `readonly code`.
export class MailerError extends Error {
  readonly code: MailerErrorCode;
  /** The HTTP status when the provider answered; undefined when it could not be reached or did not answer in time. */
  readonly status: number | undefined;
  /** The provider's error name from its answer (Resend: e.g. "concurrent_idempotent_requests"), never its message. */
  readonly reason: string | undefined;

  constructor(code: MailerErrorCode, message: string, answer: { status?: number; reason?: string } = {}) {
    super(message);
    this.name = "MailerError";
    this.code = code;
    this.status = answer.status;
    this.reason = answer.reason;
  }
}

// Header safety, applied by every Mailer whatever template built the email: subjects lose control
// characters (CR and LF included) and addresses containing any control character are refused.
const CONTROL = /\p{Cc}/gu;

export function cleanSubject(subject: string): string {
  return subject.replace(CONTROL, "").trim();
}

export function assertAddresses(email: OutgoingEmail): void {
  for (const address of [email.to, email.replyTo]) {
    if (address !== undefined && (address === "" || /\p{Cc}/u.test(address))) {
      throw new MailerError("rejected", "Email address is empty or contains a control character");
    }
  }
}
