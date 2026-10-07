import { Group, TextInput } from "../components/fields.tsx";
import { daysOfEntry, hoursToRows, rowsToHours, type DayRow } from "../lib/facts-form.ts";
import { asArray, asRecord, asString, fieldId } from "../lib/values.ts";
import { focusSoon, type StepProps } from "./types.ts";

const MAX_PLACES = 30;

export function AreaStep({ facts, setFacts, errors }: StepProps) {
  const area = asRecord(facts["serviceArea"]);
  const stored = asArray(area["places"]).map(asString);
  const places = stored.length > 0 ? stored : [""];
  const rows = hoursToRows(facts["hours"]);
  const setRows = (next: DayRow[]) => setFacts(["hours"], rowsToHours(next));
  const setRow = (i: number, change: Partial<DayRow>) => setRows(rows.map((row, n) => (n === i ? { ...row, ...change } : row)));

  // An error on stored entry i (a missing time, or closing before opening) is shown on each day in that entry.
  const opensErrors = new Map<string, string[]>();
  const closesErrors = new Map<string, string[]>();
  asArray(facts["hours"]).forEach((_, i) => {
    for (const day of daysOfEntry(facts["hours"], i)) {
      opensErrors.set(day, errors(["facts", "hours", i, "opens"]));
      closesErrors.set(day, errors(["facts", "hours", i, "closes"]));
    }
  });

  return (
    <>
      <Group id={fieldId(["facts", "serviceArea", "places"])} legend="Where do you work?" hint="Cities, towns or ZIP codes. Up to 30." errors={errors(["facts", "serviceArea", "places"])}>
        {places.map((place, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextInput
                id={fieldId(["facts", "serviceArea", "places", i])}
                label={`Place ${i + 1}`}
                max={40}
                value={place}
                errors={errors(["facts", "serviceArea", "places", i])}
                onChange={(v) => setFacts(["serviceArea", "places", i], v)}
              />
            </div>
            <button
              type="button"
              className="btn-small mb-1"
              disabled={stored.length <= 1}
              onClick={() => {
                setFacts(["serviceArea", "places"], stored.filter((_, n) => n !== i));
                focusSoon(fieldId(["facts", "serviceArea", "places"]));
              }}
            >
              Remove place {i + 1}
            </button>
          </div>
        ))}
        {places.length < MAX_PLACES ? (
          <button
            type="button"
            className="btn-secondary mt-4"
            onClick={() => {
              setFacts(["serviceArea", "places"], [...places, ""]);
              focusSoon(fieldId(["facts", "serviceArea", "places", places.length]));
            }}
          >
            Add a place
          </button>
        ) : null}
      </Group>
      <TextInput
        id={fieldId(["facts", "serviceArea", "note"])}
        label="Anything else about where you work?"
        optional
        hint="For example “Within 25 miles of downtown Austin”."
        max={80}
        value={asString(area["note"])}
        errors={errors(["facts", "serviceArea", "note"])}
        onChange={(v) => setFacts(["serviceArea", "note"], v === "" ? undefined : v)}
      />
      <Group id={fieldId(["facts", "hours"])} legend="Opening hours" hint="Check the days you are open. Leave every day unchecked to show no hours." errors={errors(["facts", "hours"])}>
        {rows.map((row, i) => (
          <div key={row.day} className="mt-3 border-t border-slate-200 pt-3 first:border-t-0">
            <div className="flex items-center gap-3">
              <input
                id={`hours-${row.day}`}
                type="checkbox"
                className="size-6 accent-blue-700"
                checked={row.open}
                onChange={(e) => setRow(i, { open: e.target.checked })}
              />
              <label htmlFor={`hours-${row.day}`} className="font-medium">
                Open on {row.day}
              </label>
            </div>
            {row.open ? (
              <div className="flex flex-wrap gap-4">
                <TextInput
                  id={`hours-${row.day}-opens`}
                  label={`${row.day} opens at`}
                  type="time"
                  value={row.opens}
                  errors={opensErrors.get(row.day) ?? []}
                  onChange={(v) => setRow(i, { opens: v })}
                />
                <TextInput
                  id={`hours-${row.day}-closes`}
                  label={`${row.day} closes at`}
                  type="time"
                  value={row.closes}
                  errors={closesErrors.get(row.day) ?? []}
                  onChange={(v) => setRow(i, { closes: v })}
                />
              </div>
            ) : null}
          </div>
        ))}
      </Group>
    </>
  );
}
