import type { InviteView } from "@asksite/core";
import { useState, type FormEvent } from "react";
import { TextInput } from "../../../../app/src/client/components/fields.tsx";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { usePageHeading } from "../../../../app/src/client/hooks/use-page-heading.ts";
import { api } from "../../../../app/src/client/lib/api.ts";
import { useResource } from "../hooks.ts";
import { revokeNotice, when } from "../lib/format.ts";

function statusOf(invite: InviteView, now: number): string {
  if (invite.usedAt !== null) return "Used";
  if (invite.revokedAt !== null) return "Revoked";
  if (invite.expiresAt <= now) return "Expired";
  return "Sent";
}

/** Invite by email only: the link is emailed and never shown here (§3.2 step 2). */
export function Invites() {
  const heading = usePageHeading<HTMLHeadingElement>("Invites", "Admin");
  const { load, reload } = useResource<{ invites: InviteView[] }>("/api/admin/invites");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const now = Date.now();

  async function send(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const res = await api<{ invite: InviteView }>("POST", "/api/admin/invites", { email: email.trim().toLowerCase() });
    if (res.ok) {
      setErrors([]);
      setMessage({ tone: "success", text: `Invite emailed to ${res.data.invite.email}.` });
      setEmail("");
      await reload();
    } else if (res.error.code === "validation_failed") {
      setErrors(["Enter an email address, like name@example.com."]);
      document.getElementById("invite-email")?.focus();
    } else setMessage({ tone: "error", text: res.error.message });
  }

  async function revoke(invite: InviteView) {
    const res = await api("DELETE", `/api/admin/invites/${invite.id}`);
    setMessage(revokeNotice(res, invite.email));
    await reload();
  }

  return (
    <section>
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Invites
      </h1>
      <form className="card mt-4 max-w-xl" noValidate onSubmit={(e) => void send(e)}>
        <TextInput id="invite-email" label="Owner's email address" type="email" autoComplete="off" value={email} onChange={setEmail} errors={errors} hint="The invite link is emailed to this address. To re-send, revoke and invite again." />
        <button type="submit" className="btn-primary mt-4">
          Send invite
        </button>
      </form>
      <div role="status">{message !== null ? <Notice tone={message.tone}>{message.text}</Notice> : null}</div>
      {load.state === "error" ? <Notice tone="error">{load.error.message}</Notice> : null}
      {load.state === "ready" ? (
        <ul className="mt-6 space-y-2">
          {load.data.invites.map((invite) => {
            const status = statusOf(invite, now);
            return (
              <li key={invite.id} className="card flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">{invite.email}</p>
                  <p className="text-sm text-slate-700">
                    {status} · sent {when(invite.createdAt)} by {invite.createdBy} · expires {when(invite.expiresAt)}
                  </p>
                </div>
                {status === "Sent" ? (
                  <button type="button" className="btn-secondary" onClick={() => void revoke(invite)}>
                    Revoke invite for {invite.email}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
