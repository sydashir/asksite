import { COPY_LIMITS, type SectionId } from "@asksite/site-schema";
import type { ComposedDocument, CurrentAi, OwnerEdits } from "@asksite/core";
import { Group, TextArea, TextInput } from "../components/fields.tsx";
import { isAllowedKey, withCopy, withServiceDescription } from "../lib/edits.ts";
import type { Fix } from "../lib/messages.ts";
import { sectionOfCopy } from "../lib/sections.ts";
import { asArray, asRecord, asString, fieldId, moveItem, type Path } from "../lib/values.ts";
import { focusFirstEnabled, focusSoon } from "../steps/types.ts";

type CopyEdits = OwnerEdits["copy"];
type Intro = "services" | "gallery" | "faq" | "contact";

interface Props {
  ai: CurrentAi;
  edits: OwnerEdits;
  composed: ComposedDocument;
  facts: Record<string, unknown>;
  setEdits: (edits: OwnerEdits) => void;
  errors: (path: Path) => string[];
  /** The fact that makes an error at this path go away, e.g. "Add a license" for "licensed" (§2.2). */
  fixFor: (path: Path) => Fix | undefined;
  openFix: (fix: Fix) => void;
  /** The owner is at (or changed) this section's wording: the preview shows its page. */
  onSection: (section: SectionId) => void;
}

const INTRO_LABEL: Record<Intro, string> = {
  services: "Introduction above your services",
  gallery: "Introduction above your photos",
  faq: "Introduction above your questions",
  contact: "Introduction above your contact form",
};

/** Every wording field, grouped by section, with the limits from Plan 1's COPY_LIMITS (§3.1 step 5). */
export function WordsTab({ ai, edits, composed, facts, setEdits, errors, fixFor, openFix, onSection }: Props) {
  const copy = asRecord(composed.copy);
  const intros = asRecord(copy["sectionIntros"]);
  const faq = asArray(copy["faq"]).map(asRecord);
  const change = (section: SectionId, fn: (c: CopyEdits) => CopyEdits) => {
    onSection(section);
    setEdits(withCopy(ai, edits, fn));
  };
  const setIntro = (key: Intro, value: string) => change(sectionOfCopy(["copy", "sectionIntros", key]), (c) => ({ ...c, sectionIntros: { ...c.sectionIntros, [key]: value === "" ? null : value } }));
  const faqMoveId = (index: number, direction: "up" | "down") => `faq-move-${direction}-${index}`;
  /** Moves a question; a button that reached the end of the list is disabled, so keyboard focus goes to the other one. */
  const moveFaq = (index: number, by: -1 | 1) => {
    setFaq(moveItem(faqItems, index, by));
    const same = by === -1 ? "up" : "down";
    focusFirstEnabled(faqMoveId(index + by, same), faqMoveId(index + by, same === "up" ? "down" : "up"));
  };
  const setFaq = (items: Array<{ question: string; answer: string }>) => change("faq", (c) => ({ ...c, faq: items }));
  const faqItems = faq.map((f) => ({ question: asString(f["question"]), answer: asString(f["answer"]) }));
  // Every service by index, so field ids and errors line up with copy.serviceDescriptions.<i>. Edits are
  // keyed by the trimmed name, as composeDocument looks them up (Plan 2 decision 14), and only by the
  // current names: withServiceDescription drops renamed or removed services' keys (A8c-2).
  const services = asArray(facts["services"]).map((s) => asString(asRecord(s)["name"]).trim());
  const descriptions = asArray(copy["serviceDescriptions"]).map(asRecord);
  const field = (...path: Array<string | number>) => {
    const fix = fixFor(["copy", ...path]);
    return {
      id: fieldId(["copy", ...path]),
      errors: errors(["copy", ...path]),
      onFocus: () => onSection(sectionOfCopy(["copy", ...path])),
      after:
        fix === undefined ? null : (
          <button type="button" className="btn-small mt-2" onClick={() => openFix(fix)}>
            {fix.label}
          </button>
        ),
    };
  };

  return (
    <div>
      <Group id="words-hero" legend="Top of the page">
        <TextInput {...field("heroHeadline")} label="Headline" max={COPY_LIMITS.heroHeadline} value={asString(copy["heroHeadline"])} onChange={(v) => change("hero", (c) => ({ ...c, heroHeadline: v }))} />
        <TextArea {...field("heroSubheadline")} label="Line under the headline" max={COPY_LIMITS.heroSubheadline} value={asString(copy["heroSubheadline"])} onChange={(v) => change("hero", (c) => ({ ...c, heroSubheadline: v }))} />
        <TextInput {...field("ctaText")} label="Button text" hint="For example “Get a quote”." max={COPY_LIMITS.ctaText} value={asString(copy["ctaText"])} onChange={(v) => change("hero", (c) => ({ ...c, ctaText: v }))} />
      </Group>

      <Group id="words-services" legend="Services">
        <TextArea {...field("sectionIntros", "services")} label={INTRO_LABEL.services} optional max={COPY_LIMITS.sectionIntro} value={asString(intros["services"])} onChange={(v) => setIntro("services", v)} />
        {services.map((name, i) =>
          name === "" ? (
            <p key={i} className="mt-5 text-slate-700">
              Service {i + 1} has no name yet. Name it under Details, in Your services, to describe it here.
            </p>
          ) : !isAllowedKey(name) ? (
            // The description is stored under the name, and OwnerEdits refuses a name this long as a key: one such key would fail every autosave.
            <div key={i} className="mt-5">
              <p className="font-medium text-slate-900">Service {i + 1}</p>
              <p className="mt-1 text-slate-700">Shorten this service name to 40 characters or fewer in the Services step to add a description.</p>
            </div>
          ) : (
            <TextArea
              key={i}
              {...field("serviceDescriptions", i, "description")}
              label={`Description of “${name}”`}
              max={COPY_LIMITS.serviceDescription}
              value={asString(descriptions[i]?.["description"])}
              onChange={(v) => change("services", (c) => withServiceDescription(c, services, name, v))}
            />
          ),
        )}
      </Group>

      <Group id="words-about" legend="About you">
        {copy["about"] === undefined ? (
          <button type="button" className="btn-secondary mt-3" onClick={() => change("about", (c) => ({ ...c, about: "" }))}>
            Add an About section
          </button>
        ) : (
          <>
            <TextArea {...field("about")} label="About text" rows={5} max={COPY_LIMITS.about} value={asString(copy["about"])} onChange={(v) => change("about", (c) => ({ ...c, about: v }))} />
            <button type="button" className="btn-small mt-3" onClick={() => change("about", (c) => ({ ...c, about: null }))}>
              Remove the About text
            </button>
          </>
        )}
      </Group>

      <Group id={fieldId(["copy", "faq"])} legend="Questions and answers" errors={errors(["copy", "faq"])}>
        <TextArea {...field("sectionIntros", "faq")} label={INTRO_LABEL.faq} optional max={COPY_LIMITS.sectionIntro} value={asString(intros["faq"])} onChange={(v) => setIntro("faq", v)} />
        {faqItems.map((item, i) => (
          <div key={i} className="mt-4 border-t border-slate-200 pt-2">
            <TextInput {...field("faq", i, "question")} label={`Question ${i + 1}`} max={COPY_LIMITS.faqQuestion} value={item.question} onChange={(v) => setFaq(faqItems.map((f, n) => (n === i ? { ...f, question: v } : f)))} />
            <TextArea {...field("faq", i, "answer")} label={`Answer ${i + 1}`} max={COPY_LIMITS.faqAnswer} value={item.answer} onChange={(v) => setFaq(faqItems.map((f, n) => (n === i ? { ...f, answer: v } : f)))} />
            <div className="mt-3 flex flex-wrap gap-2">
              <button id={faqMoveId(i, "up")} type="button" className="btn-small" disabled={i === 0} onClick={() => moveFaq(i, -1)}>
                Move question {i + 1} up
              </button>
              <button id={faqMoveId(i, "down")} type="button" className="btn-small" disabled={i === faqItems.length - 1} onClick={() => moveFaq(i, 1)}>
                Move question {i + 1} down
              </button>
              <button
                type="button"
                className="btn-small"
                onClick={() => {
                  setFaq(faqItems.filter((_, n) => n !== i));
                  focusSoon(fieldId(["copy", "faq"]));
                }}
              >
                Remove question {i + 1}
              </button>
            </div>
          </div>
        ))}
        {faqItems.length < 8 ? (
          <button
            type="button"
            className="btn-secondary mt-4"
            onClick={() => {
              setFaq([...faqItems, { question: "", answer: "" }]);
              focusSoon(fieldId(["copy", "faq", faqItems.length, "question"]));
            }}
          >
            Add a question
          </button>
        ) : null}
      </Group>

      <Group id="words-other" legend="Other introductions">
        <TextArea {...field("sectionIntros", "gallery")} label={INTRO_LABEL.gallery} optional max={COPY_LIMITS.sectionIntro} value={asString(intros["gallery"])} onChange={(v) => setIntro("gallery", v)} />
        <TextArea {...field("sectionIntros", "contact")} label={INTRO_LABEL.contact} optional max={COPY_LIMITS.sectionIntro} value={asString(intros["contact"])} onChange={(v) => setIntro("contact", v)} />
      </Group>
    </div>
  );
}
