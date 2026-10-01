import type { UploadView } from "@asksite/core";
import { isSafeUrl } from "@asksite/site-schema";
import { useState } from "react";
import { ConfirmDialog } from "../components/dialog.tsx";
import { Group, Select, TextInput } from "../components/fields.tsx";
import { api } from "../lib/api.ts";
import { NETWORK_OPTIONS } from "../lib/labels.ts";
import { altTextWarning } from "../lib/facts-form.ts";
import { preparePhoto } from "../lib/prepare-photo.ts";
import { asArray, asRecord, asString, fieldId, moveItem, type Json } from "../lib/values.ts";
import { focusSoon, type StepProps } from "./types.ts";

const MAX_WORK_PHOTOS = 12;
const MAX_LINKS = 7;
const ALT_HINT = "Say what the photo shows, for someone who cannot see it. For example “New water heater installed in a garage”. Do not write “photo of”.";

const asPhoto = (upload: UploadView): Json => ({ url: upload.url, alt: "", width: upload.width, height: upload.height });

/** Decorative: the buttons next to it name the photo. Only https URLs are shown (facts are owner-typed JSON). */
function Thumbnail({ url }: { url: string }) {
  return isSafeUrl(url, ["https:"]) ? <img src={url} alt="" className="h-24 w-32 rounded border border-slate-300 bg-slate-100 object-cover" /> : null;
}

function AltWarning({ alt }: { alt: string }) {
  const warning = altTextWarning(alt);
  return (
    <p role="status" className="mt-1 text-sm text-amber-900">
      {warning ?? ""}
    </p>
  );
}

function PhotoFields(props: StepProps & { photo: Json; path: Array<string | number>; name: string }) {
  const { photo } = props;
  return (
    <>
      <TextInput
        id={fieldId(["facts", ...props.path, "alt"])}
        label={`Describe ${props.name}`}
        hint={ALT_HINT}
        max={125}
        value={asString(photo["alt"])}
        errors={props.errors(["facts", ...props.path, "alt"])}
        onChange={(v) => props.setFacts([...props.path, "alt"], v)}
        after={<AltWarning alt={asString(photo["alt"])} />}
      />
      <TextInput
        id={fieldId(["facts", ...props.path, "caption"])}
        label={`Caption for ${props.name}`}
        optional
        max={80}
        value={asString(photo["caption"])}
        errors={props.errors(["facts", ...props.path, "caption"])}
        onChange={(v) => props.setFacts([...props.path, "caption"], v === "" ? undefined : v)}
      />
      {props.errors(["facts", ...props.path, "url"]).length > 0 ? (
        <p className="mt-1 text-sm font-medium text-red-700">{props.errors(["facts", ...props.path, "url"]).join(" ")}</p>
      ) : null}
    </>
  );
}

/** Uploads, the main photo and the work photos (§8). Also the editor's Photos tab. */
export function PhotoManager(props: StepProps) {
  const { facts, setFacts, siteId, view } = props;
  const [uploads, setUploads] = useState<UploadView[]>(view.uploads);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<UploadView | null>(null);
  const hero = facts["heroPhoto"] === undefined ? null : asRecord(facts["heroPhoto"]);
  const photos = asArray(facts["photos"]).map(asRecord);

  async function upload(file: File) {
    setBusy(true);
    setStatus("Uploading your photo…");
    const prepared = await preparePhoto(file);
    if (prepared === null) {
      setBusy(false);
      setStatus("We could not read that photo. Please choose a JPG or PNG photo.");
      return;
    }
    const form = new FormData();
    form.append("file", prepared, "photo.jpg");
    const res = await api<UploadView>("POST", `/api/sites/${siteId}/uploads`, form);
    setBusy(false);
    if (!res.ok) {
      setStatus(res.error.message);
      return;
    }
    setUploads((current) => [...current, res.data]);
    setStatus("Photo uploaded. Choose where to use it below.");
  }

  async function remove(upload: UploadView) {
    setDeleting(null);
    const res = await api("DELETE", `/api/sites/${siteId}/uploads/${upload.id}`);
    if (!res.ok) {
      setStatus(res.error.message);
      return;
    }
    setUploads((current) => current.filter((u) => u.id !== upload.id));
    if (asString(hero?.["url"]) === upload.url) setFacts(["heroPhoto"], undefined);
    setFacts(["photos"], photos.filter((p) => p["url"] !== upload.url));
    setStatus("Photo deleted.");
    // The Delete button went with the photo: keep keyboard focus on the result.
    focusSoon("photo-status");
  }

  const used = new Set([asString(hero?.["url"]), ...photos.map((p) => asString(p["url"]))]);
  return (
    <>
      <div className="mt-5">
        <label htmlFor="photo-upload" className="block font-medium">
          Upload a photo
        </label>
        <p id="photo-upload-hint" className="mt-1 text-sm text-slate-600">
          A JPG, PNG or WebP photo of your own work, up to 10 MB. Photos you did not take need the owner's permission.
        </p>
        <input
          id="photo-upload"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-describedby="photo-upload-hint"
          disabled={busy}
          className="mt-2 block w-full max-w-full text-base"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file !== undefined) void upload(file);
          }}
        />
        <p id="photo-status" role="status" tabIndex={-1} className="mt-2 text-slate-800">
          {status}
        </p>
      </div>

      {uploads.length > 0 ? (
        <Group id="photo-library" legend="Your uploaded photos">
          <ul className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {uploads.map((upload, i) => (
              <li key={upload.id} className="flex flex-wrap items-start gap-3">
                <Thumbnail url={upload.url} />
                <div className="flex flex-col gap-2">
                  <span className="text-sm text-slate-700">Uploaded photo {i + 1}</span>
                  <button type="button" className="btn-small" disabled={asString(hero?.["url"]) === upload.url} onClick={() => setFacts(["heroPhoto"], asPhoto(upload))}>
                    Use uploaded photo {i + 1} as the main photo
                  </button>
                  <button
                    type="button"
                    className="btn-small"
                    disabled={used.has(upload.url) || photos.length >= MAX_WORK_PHOTOS}
                    onClick={() => {
                      setFacts(["photos"], [...photos, asPhoto(upload)]);
                      focusSoon(fieldId(["facts", "photos", photos.length, "alt"]));
                    }}
                  >
                    Add uploaded photo {i + 1} to your work photos
                  </button>
                  <button type="button" className="btn-small" onClick={() => setDeleting(upload)}>
                    Delete uploaded photo {i + 1}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Group>
      ) : null}

      <Group id={fieldId(["facts", "heroPhoto"])} legend="Main photo" hint="Shown large at the top of your website. Optional." errors={props.errors(["facts", "heroPhoto"])}>
        {hero === null ? (
          <p className="mt-2 text-slate-700">No main photo yet. Upload one, then choose “Use as the main photo”.</p>
        ) : (
          <div className="mt-2">
            <Thumbnail url={asString(hero["url"])} />
            <PhotoFields {...props} photo={hero} path={["heroPhoto"]} name="the main photo" />
            <button type="button" className="btn-small mt-3" onClick={() => setFacts(["heroPhoto"], undefined)}>
              Stop using this main photo
            </button>
          </div>
        )}
      </Group>

      <Group id={fieldId(["facts", "photos"])} legend="Photos of your work" hint="Shown as a gallery. Up to 12." errors={props.errors(["facts", "photos"])}>
        {photos.length === 0 ? <p className="mt-2 text-slate-700">No work photos yet.</p> : null}
        {photos.map((photo, i) => (
          <div key={asString(photo["url"])} className="mt-4 border-t border-slate-200 pt-3 first:border-t-0">
            <Thumbnail url={asString(photo["url"])} />
            <PhotoFields {...props} photo={photo} path={["photos", i]} name={`work photo ${i + 1}`} />
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn-small" disabled={i === 0} onClick={() => setFacts(["photos"], moveItem(photos, i, -1))}>
                Move work photo {i + 1} up
              </button>
              <button type="button" className="btn-small" disabled={i === photos.length - 1} onClick={() => setFacts(["photos"], moveItem(photos, i, 1))}>
                Move work photo {i + 1} down
              </button>
              <button
                type="button"
                className="btn-small"
                onClick={() => {
                  setFacts(["photos"], photos.filter((_, n) => n !== i));
                  focusSoon(fieldId(["facts", "photos"]));
                }}
              >
                Stop using work photo {i + 1}
              </button>
            </div>
          </div>
        ))}
      </Group>

      {/* Deleting cannot be undone, so it asks first (WCAG 3.3.4). */}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this photo?"
        confirmLabel="Delete photo"
        onConfirm={() => {
          if (deleting !== null) void remove(deleting);
        }}
        onCancel={() => setDeleting(null)}
      >
        <p>It is removed from your photos and from this draft of your website. You cannot undo this.</p>
      </ConfirmDialog>
    </>
  );
}

function SocialLinks({ facts, setFacts, errors }: StepProps) {
  const links = asArray(facts["socialLinks"]).map(asRecord);
  return (
    <Group id={fieldId(["facts", "socialLinks"])} legend="Links to your pages elsewhere" hint="Optional. For example your Facebook page or Google Business Profile." errors={errors(["facts", "socialLinks"])}>
      {links.map((link, i) => (
        <div key={i} className="mt-4 border-t border-slate-200 pt-2 first:border-t-0">
          <Select
            id={fieldId(["facts", "socialLinks", i, "network"])}
            label={`Link ${i + 1}: website`}
            options={NETWORK_OPTIONS}
            value={asString(link["network"])}
            errors={errors(["facts", "socialLinks", i, "network"])}
            onChange={(v) => setFacts(["socialLinks", i, "network"], v === "" ? undefined : v)}
          />
          <TextInput
            id={fieldId(["facts", "socialLinks", i, "url"])}
            label={`Link ${i + 1}: address of your page`}
            hint="Starts with https://"
            type="url"
            autoComplete="url"
            value={asString(link["url"])}
            errors={errors(["facts", "socialLinks", i, "url"])}
            onChange={(v) => setFacts(["socialLinks", i, "url"], v)}
          />
          <button
            type="button"
            className="btn-small mt-3"
            onClick={() => {
              setFacts(["socialLinks"], links.filter((_, n) => n !== i));
              focusSoon(fieldId(["facts", "socialLinks"]));
            }}
          >
            Remove link {i + 1}
          </button>
        </div>
      ))}
      {links.length < MAX_LINKS ? (
        <button
          type="button"
          className="btn-secondary mt-4"
          onClick={() => {
            setFacts(["socialLinks"], [...links, { network: "facebook", url: "" }]);
            focusSoon(fieldId(["facts", "socialLinks", links.length, "network"]));
          }}
        >
          Add a link
        </button>
      ) : null}
    </Group>
  );
}

export function PhotosStep(props: StepProps) {
  return (
    <>
      <PhotoManager {...props} />
      <SocialLinks {...props} />
    </>
  );
}
