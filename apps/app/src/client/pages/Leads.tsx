import { LIMITS, type LeadView } from "@asksite/core";
import { isSafeUrl } from "@asksite/site-schema";
import { useEffect, useState } from "react";
import { Notice } from "../components/feedback.tsx";
import { usePageHeading } from "../hooks/use-page-heading.ts";
import { onLinkClick } from "../hooks/use-route.ts";
import { api } from "../lib/api.ts";
import { paths } from "../lib/route.ts";

const when = (ms: number) => new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** A tel: or mailto: link only when it passes Plan 1's URL guard; otherwise plain text (§9.1). */
function SafeLink({ href, text }: { href: string; text: string }) {
  return isSafeUrl(href, ["tel:", "mailto:"]) ? (
    <a href={href} className="link break-all">
      {text}
    </a>
  ) : (
    <span className="break-all">{text}</span>
  );
}

/** A tap-to-call link for a real phone number (7 or more digits), plain text for anything else. */
function PhoneLink({ phone }: { phone: string }) {
  const dial = phone.replace(/[^0-9+]/g, "");
  return dial.replace(/\D/g, "").length >= 7 ? <SafeLink href={`tel:${dial}`} text={phone} /> : <span className="break-all">{phone}</span>;
}

/** Messages sent through the website's contact form (§3.1 step 9). */
export function Leads({ siteId }: { siteId: string }) {
  const heading = usePageHeading<HTMLHeadingElement>("Messages from your website");
  const [leads, setLeads] = useState<LeadView[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  async function load(before: number | null) {
    const res = await api<{ leads: LeadView[]; nextBefore: number | null }>("GET", `/api/sites/${siteId}/leads?limit=50${before === null ? "" : `&before=${before}`}`);
    if (!res.ok) {
      setState("error");
      setError(res.error.message);
      return;
    }
    setLeads((current) => (before === null ? res.data.leads : [...current, ...res.data.leads]));
    setNext(res.data.nextBefore);
    setState("ready");
  }

  useEffect(() => {
    void load(null);
  }, [siteId]);

  return (
    <section className="mx-auto max-w-3xl">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold">
        Messages from your website
      </h1>
      <p className="mt-2">
        <a href={paths.edit(siteId)} onClick={onLinkClick} className="link">
          Back to editing
        </a>
      </p>
      <p className="mt-2 text-sm text-slate-700">
        To stop spam, one visitor can send up to {LIMITS.leadsPerNetworkPerSitePerDay} messages a day through your form; after that they see your phone number.
      </p>
      {state === "loading" ? <p role="status">Loading…</p> : null}
      {state === "error" ? <Notice tone="error">{error}</Notice> : null}
      {state === "ready" && leads.length === 0 ? <p className="mt-4">No messages yet. When someone uses your contact form, it shows up here and in your email.</p> : null}
      <ul className="mt-4 space-y-3">
        {leads.map((lead) => (
          <li key={lead.id} className="card">
            <h2 className="text-lg font-semibold">{lead.name}</h2>
            <p className="text-sm text-slate-600">{when(lead.createdAt)}</p>
            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[8rem_1fr]">
              <dt className="font-medium">Phone</dt>
              <dd>
                <PhoneLink phone={lead.phone} />
              </dd>
              {lead.email !== null ? (
                <>
                  <dt className="font-medium">Email</dt>
                  <dd>
                    <SafeLink href={`mailto:${lead.email}`} text={lead.email} />
                  </dd>
                </>
              ) : null}
              {lead.service !== null ? (
                <>
                  <dt className="font-medium">Service</dt>
                  <dd>{lead.service}</dd>
                </>
              ) : null}
              {lead.message !== null ? (
                <>
                  <dt className="font-medium">Message</dt>
                  <dd className="whitespace-pre-line">{lead.message}</dd>
                </>
              ) : null}
            </dl>
            {lead.emailStatus === "failed" ? <p className="mt-2 text-sm text-red-700">We could not email you this message, so it is only here.</p> : null}
          </li>
        ))}
      </ul>
      {next !== null ? (
        <button type="button" className="btn-secondary mt-4" onClick={() => void load(next)}>
          Show older messages
        </button>
      ) : null}
    </section>
  );
}
