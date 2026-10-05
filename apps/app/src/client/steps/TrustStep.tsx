import { Checkbox, Group, TextArea, TextInput } from "../components/fields.tsx";
import { yearsInput, yearsToFacts } from "../lib/facts-form.ts";
import { asArray, asRecord, asString, fieldId, setIn, type Path } from "../lib/values.ts";
import { focusSoon, type StepProps } from "./types.ts";

const MAX_LICENCES = 5;
const MAX_REVIEWS = 12;

export function TrustStep({ site, facts, brief, setFacts, setBrief, errors, thisYear, frozen }: StepProps) {
  const licences = asArray(facts["licences"]).map(asRecord);
  const reviews = asArray(facts["testimonials"]).map(asRecord);
  // Any change to the reviews clears "these are real" in the same save: the owner confirms the
  // reviews as they are now, never ones added or edited after checking the box (FTC; decision 38).
  // Frozen (the editor while new wording is written): no change at all, whatever input reaches the control (also one with no key event).
  const setReviews = (path: Path, value: unknown) =>
    frozen ? undefined : site.update((d) => ({
      facts: setIn(d.facts, ["testimonials", ...path], value),
      ...(asRecord(d.brief)["reviewsAreReal"] === true ? { brief: setIn(d.brief, ["reviewsAreReal"], false) } : {}),
    }));
  return (
    <>
      <Group id={fieldId(["facts", "licences"])} legend="Licenses" hint="Add each license exactly as it appears on the certificate. Your website shows them as entered." errors={errors(["facts", "licences"])}>
        {licences.map((licence, i) => (
          <div key={i} className="mt-4 border-t border-slate-200 pt-2 first:border-t-0">
            <TextInput
              id={fieldId(["facts", "licences", i, "label"])}
              label={`License ${i + 1}: who issued it`}
              hint="For example “Texas State Board of Plumbing Examiners”."
              max={40}
              value={asString(licence["label"])}
              errors={errors(["facts", "licences", i, "label"])}
              onChange={(v) => setFacts(["licences", i, "label"], v)}
            />
            <TextInput
              id={fieldId(["facts", "licences", i, "number"])}
              label={`License ${i + 1}: number`}
              max={30}
              value={asString(licence["number"])}
              errors={errors(["facts", "licences", i, "number"])}
              onChange={(v) => setFacts(["licences", i, "number"], v)}
            />
            <button
              type="button"
              className="btn-small mt-3"
              onClick={() => {
                setFacts(["licences"], licences.filter((_, n) => n !== i));
                focusSoon(fieldId(["facts", "licences"]));
              }}
            >
              Remove license {i + 1}
            </button>
          </div>
        ))}
        {licences.length < MAX_LICENCES ? (
          <button
            type="button"
            className="btn-secondary mt-4"
            onClick={() => {
              setFacts(["licences"], [...licences, { label: "", number: "" }]);
              focusSoon(fieldId(["facts", "licences", licences.length, "label"]));
            }}
          >
            Add a license
          </button>
        ) : null}
      </Group>
      <Checkbox id={fieldId(["facts", "insured"])} label="We are insured" checked={facts["insured"] === true} onChange={(v) => setFacts(["insured"], v)} />
      <TextInput
        id={fieldId(["facts", "yearFounded"])}
        label="Years in business"
        optional
        hint="Your website shows this as “Since” and the year you started."
        inputMode="numeric"
        value={yearsInput(facts["yearFounded"], thisYear)}
        errors={errors(["facts", "yearFounded"])}
        onChange={(v) => setFacts(["yearFounded"], yearsToFacts(v, thisYear))}
      />
      <Group
        id={fieldId(["facts", "testimonials"])}
        legend="Reviews from customers"
        hint="Paste real reviews word for word, for example from Google. Never write your own: fake reviews are illegal."
        errors={errors(["facts", "testimonials"])}
      >
        {reviews.map((review, i) => (
          <div key={i} className="mt-4 border-t border-slate-200 pt-2 first:border-t-0">
            <TextArea
              id={fieldId(["facts", "testimonials", i, "quote"])}
              label={`Review ${i + 1}`}
              max={320}
              value={asString(review["quote"])}
              errors={errors(["facts", "testimonials", i, "quote"])}
              onChange={(v) => setReviews([i, "quote"], v)}
            />
            <TextInput
              id={fieldId(["facts", "testimonials", i, "name"])}
              label={`Review ${i + 1}: customer's name`}
              hint="As they gave it, for example “Maria G.”."
              max={40}
              value={asString(review["name"])}
              errors={errors(["facts", "testimonials", i, "name"])}
              onChange={(v) => setReviews([i, "name"], v)}
            />
            <TextInput
              id={fieldId(["facts", "testimonials", i, "location"])}
              label={`Review ${i + 1}: customer's town`}
              optional
              max={40}
              value={asString(review["location"])}
              errors={errors(["facts", "testimonials", i, "location"])}
              onChange={(v) => setReviews([i, "location"], v === "" ? undefined : v)}
            />
            <button
              type="button"
              className="btn-small mt-3"
              onClick={() => {
                setReviews([], reviews.filter((_, n) => n !== i));
                focusSoon(fieldId(["facts", "testimonials"]));
              }}
            >
              Remove review {i + 1}
            </button>
          </div>
        ))}
        {reviews.length < MAX_REVIEWS ? (
          <button
            type="button"
            className="btn-secondary mt-4"
            onClick={() => {
              setReviews([], [...reviews, { quote: "", name: "" }]);
              focusSoon(fieldId(["facts", "testimonials", reviews.length, "quote"]));
            }}
          >
            Add a review
          </button>
        ) : null}
      </Group>
      {reviews.length > 0 ? (
        <Checkbox
          id={fieldId(["brief", "reviewsAreReal"])}
          label="These reviews are from real customers, copied word for word"
          hint="Changing a review clears this box, so you confirm the reviews as they are."
          checked={brief["reviewsAreReal"] === true}
          errors={errors(["brief", "reviewsAreReal"])}
          onChange={(v) => setBrief(["reviewsAreReal"], v)}
        />
      ) : null}
    </>
  );
}
