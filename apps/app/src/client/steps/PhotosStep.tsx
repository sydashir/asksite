import { Group, Select, TextInput } from "../components/fields.tsx";
import { NETWORK_OPTIONS } from "../lib/labels.ts";
import { asArray, asRecord, asString, fieldId } from "../lib/values.ts";
import { focusSoon, type StepProps } from "./types.ts";

const MAX_LINKS = 7;

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

/** Step 5. Photo uploads join this step in the next task; the links work on their own. */
export function PhotosStep(props: StepProps) {
  return <SocialLinks {...props} />;
}
