import { Errors, Hint, Label } from "../components/fields.tsx";
import { formatUsd, formatUsdInput, MAX_PRICE_CENTS, parseUsdCents } from "../lib/money.ts";

interface Props {
  id: string;
  label: string;
  /** The text as typed; the container keeps it and turns it into cents with parseUsdCents. */
  value: string;
  onChange: (text: string) => void;
  hint?: string;
  errors?: readonly string[];
  optional?: boolean;
  readOnly?: boolean;
  maxCents?: number;
  /** In a table row (each size's price): the label is for screen readers only (the column header shows it), and no "Shown as" line. */
  compact?: boolean;
  /** What an empty optional price means, e.g. "Uses the product's price, $9.90." */
  emptyText?: string;
}

/**
 * A price in US dollars, typed the way people write it ("9.9", "$9.90", "1,200"). The text stays as typed while the owner types;
 * on leaving the field a good price is rewritten as "9.90" (or "89"), and the line under it says how the site shows it. The "$" in front is
 * drawn, not typed (the label says dollars). `inputMode="decimal"` brings up a keyboard with a dot on phones.
 */
export function PriceInput(props: Props) {
  const errors = props.errors ?? [];
  const parsed = parseUsdCents(props.value, props.maxCents ?? MAX_PRICE_CENTS);
  const shown = props.compact ? null : parsed.ok ? `Shown as ${formatUsd(parsed.cents, "short")}.` : props.value.trim() === "" && props.emptyText !== undefined ? props.emptyText : null;
  const describedBy = [props.hint ? `${props.id}-hint` : "", shown !== null ? `${props.id}-shown` : "", errors.length > 0 ? `${props.id}-error` : ""].filter(Boolean).join(" ");
  return (
    <div className={props.compact ? undefined : "mt-5"}>
      {props.compact ? (
        <label htmlFor={props.id} className="sr-only">
          {props.label}
        </label>
      ) : (
        <Label id={props.id} label={props.label} optional={props.optional} />
      )}
      <Hint id={props.id} hint={props.hint} />
      <div className={props.compact ? "price-field mt-0" : "price-field"}>
        <span aria-hidden="true" className="price-symbol">
          $
        </span>
        <input
          id={props.id}
          className="field-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={props.value}
          readOnly={props.readOnly}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={() => {
            if (!parsed.ok || props.readOnly) return;
            const tidy = formatUsdInput(parsed.cents);
            if (tidy !== props.value) props.onChange(tidy);
          }}
          aria-invalid={errors.length > 0 ? true : undefined}
          aria-describedby={describedBy === "" ? undefined : describedBy}
        />
      </div>
      {shown !== null ? (
        <p id={`${props.id}-shown`} className="mt-1 text-sm text-slate-600">
          {shown}
        </p>
      ) : null}
      <Errors id={props.id} errors={errors} />
    </div>
  );
}
