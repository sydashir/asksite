import type { ReactNode } from "react";

// Native form controls with a visible <label>, an optional hint, and errors tied to the control
// with aria-describedby (§9.2). Nothing here truncates what the owner types: long text shows an
// over-limit counter and an error instead.

interface Common {
  id: string;
  label: string;
  hint?: string;
  errors?: readonly string[];
  optional?: boolean;
  /** Shown under the errors, e.g. a button that opens the fact that fixes the error. */
  after?: ReactNode;
}

function describedBy(id: string, hint: string | undefined, errors: readonly string[], counter: boolean): string | undefined {
  const ids = [hint ? `${id}-hint` : "", counter ? `${id}-count` : "", errors.length > 0 ? `${id}-error` : ""].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function Label({ id, label, optional }: { id: string; label: string; optional?: boolean | undefined }) {
  return (
    <label htmlFor={id} className="block font-medium text-slate-900">
      {label}
      {optional ? <span className="font-normal text-slate-600"> (optional)</span> : null}
    </label>
  );
}

function Hint({ id, hint }: { id: string; hint?: string | undefined }) {
  return hint ? (
    <p id={`${id}-hint`} className="mt-1 text-sm text-slate-600">
      {hint}
    </p>
  ) : null;
}

function Errors({ id, errors }: { id: string; errors: readonly string[] }) {
  return errors.length > 0 ? (
    <p id={`${id}-error`} className="mt-1 text-sm font-medium text-red-700">
      {errors.join(" ")}
    </p>
  ) : null;
}

function Counter({ id, length, max }: { id: string; length: number; max: number }) {
  return (
    <p id={`${id}-count`} className={length > max ? "mt-1 text-sm font-medium text-red-700" : "mt-1 text-sm text-slate-600"}>
      {length} of {max} characters
    </p>
  );
}

const INPUT =
  "mt-1 block w-full rounded-md border border-slate-500 bg-white px-3 py-2 text-base text-slate-900 aria-[invalid=true]:border-red-700 aria-[invalid=true]:border-2";

export function TextInput(
  props: Common & {
    value: string;
    onChange: (value: string) => void;
    type?: "text" | "email" | "tel" | "url" | "number" | "time" | "search";
    autoComplete?: string;
    inputMode?: "text" | "numeric" | "tel" | "email" | "url";
    max?: number;
    spellCheck?: boolean;
  },
) {
  const errors = props.errors ?? [];
  const counted = props.max !== undefined;
  return (
    <div className="mt-5">
      <Label id={props.id} label={props.label} optional={props.optional} />
      <Hint id={props.id} hint={props.hint} />
      <input
        id={props.id}
        className={INPUT}
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete ?? "off"}
        inputMode={props.inputMode}
        spellCheck={props.spellCheck}
        aria-invalid={errors.length > 0 ? true : undefined}
        aria-describedby={describedBy(props.id, props.hint, errors, counted)}
      />
      {counted ? <Counter id={props.id} length={props.value.length} max={props.max!} /> : null}
      <Errors id={props.id} errors={errors} />
      {props.after}
    </div>
  );
}

export function TextArea(props: Common & { value: string; onChange: (value: string) => void; rows?: number; max?: number }) {
  const errors = props.errors ?? [];
  const counted = props.max !== undefined;
  return (
    <div className="mt-5">
      <Label id={props.id} label={props.label} optional={props.optional} />
      <Hint id={props.id} hint={props.hint} />
      <textarea
        id={props.id}
        className={INPUT}
        rows={props.rows ?? 3}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-invalid={errors.length > 0 ? true : undefined}
        aria-describedby={describedBy(props.id, props.hint, errors, counted)}
      />
      {counted ? <Counter id={props.id} length={props.value.length} max={props.max!} /> : null}
      <Errors id={props.id} errors={errors} />
      {props.after}
    </div>
  );
}

export function Select(
  props: Common & { value: string; onChange: (value: string) => void; options: ReadonlyArray<{ value: string; label: string }>; autoComplete?: string },
) {
  const errors = props.errors ?? [];
  return (
    <div className="mt-5">
      <Label id={props.id} label={props.label} optional={props.optional} />
      <Hint id={props.id} hint={props.hint} />
      <select
        id={props.id}
        className={INPUT}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete ?? "off"}
        aria-invalid={errors.length > 0 ? true : undefined}
        aria-describedby={describedBy(props.id, props.hint, errors, false)}
      >
        <option value="">Choose…</option>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Errors id={props.id} errors={errors} />
    </div>
  );
}

export function Checkbox(props: { id: string; label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void; errors?: readonly string[] }) {
  const errors = props.errors ?? [];
  return (
    <div className="mt-5">
      <div className="flex items-start gap-3">
        <input
          id={props.id}
          type="checkbox"
          className="mt-1 size-6 shrink-0 accent-blue-700"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
          aria-invalid={errors.length > 0 ? true : undefined}
          aria-describedby={describedBy(props.id, props.hint, errors, false)}
        />
        <div>
          <label htmlFor={props.id} className="font-medium text-slate-900">
            {props.label}
          </label>
          <Hint id={props.id} hint={props.hint} />
        </div>
      </div>
      <Errors id={props.id} errors={errors} />
    </div>
  );
}

export function RadioGroup(
  props: Common & { name: string; value: string; onChange: (value: string) => void; options: ReadonlyArray<{ value: string; label: string; hint?: string }> },
) {
  const errors = props.errors ?? [];
  return (
    <fieldset id={props.id} tabIndex={-1} className="mt-5" aria-describedby={describedBy(props.id, props.hint, errors, false)}>
      <legend className="font-medium text-slate-900">{props.label}</legend>
      <Hint id={props.id} hint={props.hint} />
      <div className="mt-2 space-y-2">
        {props.options.map((o) => (
          <div key={o.value} className="flex items-start gap-3">
            <input
              id={`${props.id}-${o.value}`}
              type="radio"
              name={props.name}
              className="mt-1 size-6 shrink-0 accent-blue-700"
              value={o.value}
              checked={props.value === o.value}
              onChange={() => props.onChange(o.value)}
            />
            <label htmlFor={`${props.id}-${o.value}`} className="text-slate-900">
              {o.label}
              {o.hint ? <span className="block text-sm text-slate-600">{o.hint}</span> : null}
            </label>
          </div>
        ))}
      </div>
      <Errors id={props.id} errors={errors} />
    </fieldset>
  );
}

/** A titled group of fields (a list of services, the weekly hours). Focusable so fixes can land on it. */
export function Group(props: { id: string; legend: string; hint?: string; errors?: readonly string[]; children: ReactNode }) {
  const errors = props.errors ?? [];
  return (
    <fieldset id={props.id} tabIndex={-1} className="mt-6 rounded-lg border border-slate-300 p-4" aria-describedby={describedBy(props.id, props.hint, errors, false)}>
      <legend className="px-1 font-semibold text-slate-900">{props.legend}</legend>
      <Hint id={props.id} hint={props.hint} />
      <Errors id={props.id} errors={errors} />
      {props.children}
    </fieldset>
  );
}
