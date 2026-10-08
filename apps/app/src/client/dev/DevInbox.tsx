import { useEffect, useRef, useState, type FormEvent } from "react";
import { Notice } from "../components/feedback.tsx";
import { TextInput } from "../components/fields.tsx";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { onLinkClick } from "../hooks/use-route.ts";
import { api } from "../lib/api.ts";
import { EmailText, emailActions, TAG_LABEL } from "./email-text.ts";

interface OutboxMessage {
  at: number;
  to: string;
  subject: string;
  text: string;
  tag: string;
}

const NOT_AVAILABLE = "The inbox is not available. It works only in the local development app.";
const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

export function DevInbox() {
  const heading = usePageHeading<HTMLHeadingElement>("Local inbox");
  const [to, setTo] = useState(() => new URLSearchParams(location.search).get("to") ?? "");
  const [fieldError, setFieldError] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [messages, setMessages] = useState<OutboxMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(0);

  async function load(address: string) {
    const request = ++latest.current;
    setLoading(true);
    setError("");
    const res = await api<{ messages: OutboxMessage[] }>("GET", `/api/dev/outbox?to=${encodeURIComponent(address)}`);
    if (request !== latest.current) return;
    setLoading(false);
    if (!res.ok) {
      setShown(null);
      setMessages([]);
      setError(res.status === 404 ? NOT_AVAILABLE : res.error.message);
      return;
    }
    setShown(address);
    setMessages(res.data.messages);
  }

  useEffect(() => {
    const initial = new URLSearchParams(location.search).get("to");
    if (initial !== null && initial.trim() !== "") void load(initial.trim().toLowerCase());
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = to.trim().toLowerCase();
    if (address === "") {
      setFieldError("Enter an email address.");
      document.getElementById("inbox-to")?.focus();
      return;
    }
    setFieldError("");
    setTo(address);
    history.replaceState(null, "", `/dev/inbox?to=${encodeURIComponent(address)}`);
    void load(address);
  }

  const status = loading
    ? "Loading emails…"
    : shown === null
      ? ""
      : messages.length === 0
        ? `No emails for ${shown} yet.`
        : `${messages.length} ${messages.length === 1 ? "email" : "emails"} for ${shown}.`;

  return (
    <section className="mx-auto max-w-3xl">
      <p>
        <a href="/dev" onClick={onLinkClick} className="link back-link">
          Back to demo start
        </a>
      </p>
      <h1 ref={heading} tabIndex={-1} className="page-title mt-3">
        Local inbox
      </h1>
      <p className="dev-box mt-3">Development only. These are the emails the app wrote on this computer. Nothing here was sent, and this page is not in the live app.</p>
      <form className="card mt-6 max-w-xl" noValidate onSubmit={submit}>
        <TextInput
          id="inbox-to"
          label="Email address"
          type="email"
          autoComplete="off"
          hint="Shows the 50 newest emails sent to this address."
          value={to}
          onChange={setTo}
          errors={fieldError === "" ? [] : [fieldError]}
        />
        <button type="submit" className="btn-primary mt-4">
          Show emails
        </button>
      </form>
      {/* One status region that stays in the page, so each new sentence is announced. */}
      <p role="status" className={loading ? "loading mt-4" : "meta mt-4"}>
        {loading ? <span className="spinner" aria-hidden="true" /> : null}
        {status}
      </p>
      {shown !== null || error !== "" ? (
        <button type="button" className="btn-secondary mt-2" onClick={() => void load(shown ?? to.trim().toLowerCase())}>
          Check again
        </button>
      ) : null}
      {error !== "" ? (
        <div role="alert" className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
      <ol className="mt-6 space-y-4">
        {messages.map((message, i) => {
          const actions = emailActions(message.text);
          return (
            <li key={`${message.at}-${i}`} className="card">
              <h2 className="section-title">{message.subject}</h2>
              <p className="meta mt-1">
                To {message.to} · {DATE.format(message.at)} · <span className="pill">{TAG_LABEL[message.tag] ?? message.tag}</span>
              </p>
              {actions.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {actions.map((action) => (
                    <a key={action.href} href={action.href} className="btn-primary">
                      {action.label}
                    </a>
                  ))}
                </div>
              ) : null}
              <div className="email-body">
                <EmailText text={message.text} />
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
