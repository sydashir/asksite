import { Checkbox, Group, TextInput } from "../components/fields.tsx";
import { priceInput, priceToFacts } from "../lib/facts-form.ts";
import { asArray, asRecord, asString, fieldId, moveItem } from "../lib/values.ts";
import { focusSoon, type StepProps } from "./types.ts";

const MAX_SERVICES = 12;

export function ServicesStep({ facts, setFacts, errors }: StepProps) {
  const stored = asArray(facts["services"]).map(asRecord);
  // Show one empty row before the first service is typed; it is saved once the owner types.
  const services = stored.length > 0 ? stored : [{}];
  return (
    <>
      <Group
        id={fieldId(["facts", "services"])}
        legend="Services you offer"
        hint="List your main services, most important first. Up to 12."
        errors={errors(["facts", "services"])}
      >
        {services.map((service, i) => (
          <div key={i} className="mt-4 border-t border-slate-200 pt-2 first:border-t-0">
            <TextInput
              id={fieldId(["facts", "services", i, "name"])}
              label={`Service ${i + 1}`}
              max={40}
              value={asString(service["name"])}
              errors={errors(["facts", "services", i, "name"])}
              onChange={(v) => setFacts(["services", i, "name"], v)}
            />
            <TextInput
              id={fieldId(["facts", "services", i, "startingPrice"])}
              label={`Starting price for service ${i + 1}, in dollars`}
              optional
              hint="Shown as “From $89”. Leave empty to show no price."
              inputMode="numeric"
              value={priceInput(service["startingPrice"])}
              errors={errors(["facts", "services", i, "startingPrice"])}
              onChange={(v) => setFacts(["services", i, "startingPrice"], priceToFacts(v))}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn-small" disabled={i === 0} onClick={() => setFacts(["services"], moveItem(stored, i, -1))}>
                Move service {i + 1} up
              </button>
              <button type="button" className="btn-small" disabled={i >= stored.length - 1} onClick={() => setFacts(["services"], moveItem(stored, i, 1))}>
                Move service {i + 1} down
              </button>
              <button
                type="button"
                className="btn-small"
                disabled={stored.length <= 1}
                onClick={() => {
                  setFacts(["services"], stored.filter((_, n) => n !== i));
                  focusSoon(fieldId(["facts", "services"]));
                }}
              >
                Remove service {i + 1}
              </button>
            </div>
          </div>
        ))}
        {services.length < MAX_SERVICES ? (
          <button
            type="button"
            className="btn-secondary mt-4"
            onClick={() => {
              setFacts(["services"], [...services, { name: "" }]);
              focusSoon(fieldId(["facts", "services", services.length, "name"]));
            }}
          >
            Add a service
          </button>
        ) : null}
      </Group>
      <Checkbox
        id={fieldId(["facts", "freeEstimates"])}
        label="We give free estimates or quotes"
        hint="Only then can your website say “free”."
        checked={facts["freeEstimates"] === true}
        onChange={(v) => setFacts(["freeEstimates"], v)}
      />
      <Checkbox
        id={fieldId(["facts", "emergency247"])}
        label="We offer 24/7 emergency service"
        hint="Only then can your website mention emergencies or round-the-clock service."
        checked={facts["emergency247"] === true}
        onChange={(v) => setFacts(["emergency247"], v)}
      />
    </>
  );
}
