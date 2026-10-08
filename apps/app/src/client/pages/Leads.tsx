import { LIMITS, type LeadView } from "@asksite/core";
import { isSafeUrl } from "@asksite/site-schema";
import { useEffect, useRef, useState } from "react";
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
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingRef = useRef(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusCard = useRef<HTMLLIElement>(null);

  async function load(before: number | null) {
    const res = await api<{ leads: LeadView[]; nextBefore: number | null }>("GET", `/api/sites/${siteId}/leads?limit=50${before === null ? "" : `&before=${before}`}`);
    if (!res.ok) {
      setState("error");
      setError(res.error.message);
      return;
    }
    if (before === null) setLeads(res.data.leads);
    else {
      const listed = new Set(leads.map((lead) => lead.id));
      const fresh = res.data.leads.filter((lead) => !listed.has(lead.id));
      setLeads([...leads, ...fresh]);
      // The button unmounts with the last page: keyboard focus moves to the first new card instead of dropping to the page.
      if (res.data.nextBefore === null && fresh[0] !== undefined) setFocusId(fresh[0].id);
    }
    setNext(res.data.nextBefore);
    setState("ready");
  }

  async function loadOlder(before: number) {
    // aria-disabled keeps the button focusable, so presses while loading are ignored here (a native disabled drops focus).
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    await load(before);
    loadingRef.current = false;
    setLoadingOlder(false);
  }

  useEffect(() => {
    void load(null);
  }, [siteId]);

  useEffect(() => {
    if (focusId !== null) focusCard.current?.focus();
  }, [focusId]);

  return (
    <section className="mx-auto max-w-3xl">
      <h1 ref={heading} tabIndex={-1} className="page-title">
        Messages from your website
      </h1>
      <p className="mt-2">
        <a href={paths.edit(siteId)} onClick={onLinkClick} className="link back-link">
          Back to editing
        </a>
      </p>
      <p className="meta mt-2 text-sm">
        To stop spam, one visitor can send up to {LIMITS.leadsPerNetworkPerSitePerDay} messages a day through your form; after that they see your phone number.
      </p>
      {state === "loading" ? (
        <p role="status" className="loading mt-4">
          <span className="spinner" aria-hidden="true" />
          Loading…
        </p>
      ) : null}
      {state === "error" ? (
        <div role="alert">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
      {state === "ready" && leads.length === 0 ? (
        <div className="empty-state mt-4">
          <p className="text-slate-700">No messages yet. When someone uses your contact form, it shows up here and in your email.</p>
        </div>
      ) : null}
      <ul className="mt-6 space-y-3">
        {leads.map((lead) => (
          <li key={lead.id} className="card" ref={lead.id === focusId ? focusCard : undefined} tabIndex={lead.id === focusId ? -1 : undefined}>
            <h2 className="section-title">{lead.name}</h2>
            <p className="meta text-sm">{when(lead.createdAt)}</p>
            <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[8rem_1fr]">
              <dt className="text-slate-600">Phone</dt>
              <dd>
                <PhoneLink phone={lead.phone} />
              </dd>
              {lead.email !== null ? (
                <>
                  <dt className="text-slate-600">Email</dt>
                  <dd>
                    <SafeLink href={`mailto:${lead.email}`} text={lead.email} />
                  </dd>
                </>
              ) : null}
              {lead.service !== null ? (
                <>
                  <dt className="text-slate-600">Service</dt>
                  <dd>{lead.service}</dd>
                </>
              ) : null}
              {lead.message !== null ? (
                <>
                  <dt className="text-slate-600">Message</dt>
                  <dd className="whitespace-pre-line">{lead.message}</dd>
                </>
              ) : null}
            </dl>
            {lead.emailStatus === "failed" ? <p className="mt-2 text-sm text-red-700">We could not email you this message, so it is only here.</p> : null}
          </li>
        ))}
      </ul>
      {next !== null ? (
        <button type="button" className="btn-secondary mt-4" aria-disabled={loadingOlder} aria-busy={loadingOlder} onClick={() => void loadOlder(next)}>
          {loadingOlder ? "Loading older messages…" : "Show older messages"}
        </button>
      ) : null}
    </section>
  );
}
