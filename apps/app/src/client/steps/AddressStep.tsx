import { siteUrl } from "@asksite/core";
import { useEffect, useState } from "react";
import { TextInput } from "../components/fields.tsx";
import { api } from "../lib/api.ts";
import { suggestSlug } from "../lib/facts-form.ts";
import { fieldId } from "../lib/values.ts";
import type { StepProps } from "./types.ts";

type Reason = "taken" | "invalid" | "reserved" | "blocked";

const REASON_TEXT: Record<Reason, string> = {
  taken: "Someone else has this address. Try adding your town, like joes-plumbing-austin.",
  invalid: "Use 3 to 40 lower-case letters, numbers and single hyphens, starting and ending with a letter or number.",
  reserved: "This address is reserved. Please choose another.",
  blocked: "This address cannot be used. Please choose another.",
};

/** Step 7: choose the web address, with a live availability check (§3.1 step 3.7). */
export function AddressStep({ siteId, view, site, facts, errors, frozen }: StepProps) {
  const locked = view.live || view.inReview || view.liveVersion !== null;
  const [value, setValue] = useState(view.slug ?? suggestSlug(facts["businessName"]));
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveStatus = site.saver.status;

  // The "answers not saved" notice is about the autosave, not the address: it goes as soon as the autosave tries again.
  useEffect(() => {
    if (saveStatus !== "error") setUnsaved(false);
  }, [saveStatus]);

  useEffect(() => {
    if (locked) return;
    if (value === view.slug) {
      setCheck({ ok: true, text: "This is your web address." });
      return;
    }
    if (value === "") {
      setCheck(null);
      return;
    }
    const timer = setTimeout(() => {
      void api<{ available: boolean; reason: Reason | null }>("GET", `/api/slugs/${encodeURIComponent(value)}/availability`).then((res) => {
        if (!res.ok) setCheck({ ok: false, text: res.error.message });
        else if (res.data.available) setCheck({ ok: true, text: "This address is free. Save it to keep it." });
        else setCheck({ ok: false, text: REASON_TEXT[res.data.reason ?? "invalid"] });
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [value, view.slug, locked]);

  const cannotSave = saving || value === view.slug || check?.ok !== true;

  async function save() {
    if (frozen || cannotSave) return;
    setSaving(true);
    await site.exclusive(async () => {
      // The address is saved against the newest rev: if the owner's latest answers did not save, say so and stop. Not a leave, so it
      // uses saveNow: it never uses up the stop owed for a dropped wording change (the notice is carried through the reload instead).
      if (!(await site.retry())) {
        setUnsaved(true);
        return;
      }
      const res = await api<{ rev: number; slug: string }>("PUT", `/api/sites/${siteId}/slug`, { rev: site.rev(), slug: value });
      if (res.ok) await site.reload();
      else setCheck({ ok: false, text: res.error.issues?.[0] !== undefined ? REASON_TEXT[res.error.issues[0].code as Reason] ?? res.error.message : res.error.message });
    });
    setSaving(false);
  }

  if (locked) {
    return (
      <p className="mt-5">
        Your web address is <strong>{view.slug === null ? "" : siteUrl(__ROOT_DOMAIN__, view.slug)}</strong>. It cannot change after your website has been sent
        for review.
      </p>
    );
  }
  return (
    <>
      <TextInput
        id={fieldId(["slug"])}
        label="Web address"
        hint="Lower-case letters, numbers and hyphens. It cannot change after your website is sent for review."
        autoComplete="off"
        spellCheck={false}
        max={40}
        value={value}
        errors={errors(["slug"])}
        readOnly={saving}
        onChange={(v) => setValue(v.toLowerCase().trim())}
      />
      <p className="mt-2 break-all text-slate-800">
        Your website will be at <strong>{siteUrl(__ROOT_DOMAIN__, value === "" ? "your-name" : value)}</strong>
      </p>
      <p role="status" className={unsaved || check?.ok === false ? "mt-2 font-medium text-red-700" : "mt-2 text-green-800"}>
        {unsaved ? "Your latest answers are not saved yet. Please try again in a moment." : (check?.text ?? "")}
      </p>
      <button type="button" className="btn-secondary mt-4" aria-disabled={cannotSave} onClick={() => void save()}>
        {saving ? "Saving…" : "Save this web address"}
      </button>
    </>
  );
}
