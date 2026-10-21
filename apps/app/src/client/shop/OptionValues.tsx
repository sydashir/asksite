import { useRef, useState } from "react";
import { addedText, addOptionValues, OPTION_LIMITS, type OptionLimits } from "./catalog.ts";

interface Props {
  id: string;
  /** The list's name as the owner typed it ("Size"); "Choices" when empty. */
  name: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  errors?: readonly string[];
  readOnly?: boolean;
  limits?: OptionLimits;
}

/**
 * One list of choices (sizes, colours) as chips. Type one and press Enter or "Add", or several at once with commas
 * ("6, 7, 8"). Each chip has its own remove button, named with the value ("Remove Size 7"). What was added, and anything left
 * out, is said in a status line under the field.
 */
export function OptionValues(props: Props) {
  const readOnly = props.readOnly === true;
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const name = props.name.trim() || "Choices";
  const limits = props.limits ?? OPTION_LIMITS;
  const full = props.values.length >= limits.maxValues;
  const errors = [...(props.errors ?? []), ...problems];

  function add() {
    if (readOnly) return;
    const result = addOptionValues(props.values, typed, limits);
    setProblems(result.problems);
    setStatus(addedText(result.added));
    if (result.added.length > 0) props.onChange(result.values);
    if (result.problems.length === 0) setTyped("");
  }

  function remove(index: number) {
    if (readOnly) return;
    const value = props.values[index]!;
    props.onChange(props.values.filter((_, i) => i !== index));
    setProblems([]);
    setStatus(`Removed ${value}.`);
    // The pressed chip is gone: keyboard focus goes to the typing field, not to the page.
    input.current?.focus();
  }

  const describedBy = [`${props.id}-hint`, errors.length > 0 ? `${props.id}-error` : ""].filter(Boolean).join(" ");
  return (
    <div className="mt-4">
      <p id={`${props.id}-label`} className="font-medium text-ink">
        {name}
      </p>
      {props.values.length > 0 ? (
        <ul aria-labelledby={`${props.id}-label`} className="mt-2 flex flex-wrap gap-2">
          {props.values.map((value, i) => (
            <li key={value} className="chip">
              <span className="break-all">{value}</span>
              <button type="button" className="chip-remove" aria-label={`Remove ${name} ${value}`} aria-disabled={readOnly} onClick={() => remove(i)}>
                <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-slate-600">None yet.</p>
      )}
      <label htmlFor={props.id} className="mt-3 block text-sm font-medium text-ink">
        Add to {name}
      </label>
      <p id={`${props.id}-hint`} className="mt-1 text-sm text-slate-600">
        {full ? `The list is full: up to ${limits.maxValues}.` : `Press Enter after each one, or type several with commas: 6, 7, 8. Up to ${limits.maxValues}.`}
      </p>
      <div className="mt-1.5 flex gap-2">
        <input
          ref={input}
          id={props.id}
          className="field-input mt-0"
          type="text"
          autoComplete="off"
          value={typed}
          readOnly={readOnly || full}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
          aria-invalid={errors.length > 0 ? true : undefined}
          aria-describedby={describedBy}
        />
        <button type="button" className="btn-secondary shrink-0" aria-disabled={readOnly || full || typed.trim() === ""} onClick={() => (typed.trim() === "" || full ? undefined : add())}>
          Add<span className="sr-only"> to {name}</span>
        </button>
      </div>
      {errors.length > 0 ? (
        <p id={`${props.id}-error`} className="mt-1 text-sm font-medium text-red-700">
          {errors.join(" ")}
        </p>
      ) : null}
      <p role="status" className="sr-only">
        {status}
      </p>
    </div>
  );
}
