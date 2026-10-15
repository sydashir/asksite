import { Checkbox, Errors, TextArea } from "../components/fields.tsx";
import { fieldId } from "../lib/values.ts";
import { FULFILMENT, FULFILMENT_LABEL, type Fulfilment } from "./catalog.ts";

/** The shop's settings as the form holds them (the contract's ShopSettings, §2.4; empty text = not given). */
export interface ShopSettingsDraft {
  fulfilment: Fulfilment[];
  orderNote: string;
  returns: string;
  sizing: string;
  formerPricesConfirmed: boolean;
}

interface Props {
  settings: ShopSettingsDraft;
  onChange: (settings: ShopSettingsDraft) => void;
  errors: (path: ReadonlyArray<string | number>) => readonly string[];
  readOnly?: boolean;
}

const id = (path: ReadonlyArray<string | number>) => fieldId(["shop", ...path]);

/**
 * How buyers get their orders, the note on the cart and order emails, the client's returns and sizing words (shown exactly as
 * typed; empty means the website says nothing about them), and the client's confirmation that their "was" prices are real.
 */
export function ShopSettings(props: Props) {
  const { settings } = props;
  const readOnly = props.readOnly === true;
  const set = (patch: Partial<ShopSettingsDraft>) => props.onChange({ ...settings, ...patch });
  const fulfilmentErrors = props.errors(["fulfilment"]);
  return (
    <section aria-labelledby="shop-settings-title">
      <h2 id="shop-settings-title" className="section-title">
        Shop settings
      </h2>
      <fieldset id={id(["fulfilment"])} tabIndex={-1} className="mt-5" aria-describedby={`${id(["fulfilment"])}-hint${fulfilmentErrors.length > 0 ? ` ${id(["fulfilment"])}-error` : ""}`}>
        <legend className="font-medium text-ink">How do buyers get their orders?</legend>
        <p id={`${id(["fulfilment"])}-hint`} className="mt-1 text-sm text-slate-600">
          Tick every way the client offers. The website mentions only these.
        </p>
        <div className="mt-2 space-y-2">
          {FULFILMENT.map((way) => (
            <div key={way} className="flex items-start gap-3">
              <input
                id={id(["fulfilment", way])}
                type="checkbox"
                className="mt-0.5 size-6 shrink-0 accent-brand-800"
                checked={settings.fulfilment.includes(way)}
                disabled={readOnly}
                onChange={(e) => set({ fulfilment: FULFILMENT.filter((w) => (w === way ? e.target.checked : settings.fulfilment.includes(w))) })}
              />
              <label htmlFor={id(["fulfilment", way])} className="text-slate-900">
                {FULFILMENT_LABEL[way].label}
                <span className="block text-sm text-slate-600">{FULFILMENT_LABEL[way].hint}</span>
              </label>
            </div>
          ))}
        </div>
        <Errors id={id(["fulfilment"])} errors={fulfilmentErrors} />
      </fieldset>
      <TextArea
        id={id(["orderNote"])}
        label="Note for buyers"
        optional
        hint="Shown in the cart and in every order email. For example “Pickup Tuesday to Saturday at our Austin store.”"
        max={400}
        value={settings.orderNote}
        readOnly={readOnly}
        errors={props.errors(["orderNote"])}
        onChange={(orderNote) => set({ orderNote })}
      />
      <TextArea
        id={id(["returns"])}
        label="Returns and exchanges"
        optional
        hint="The client's own policy, shown as typed. Leave it empty if they gave none: the website then says nothing about returns."
        rows={4}
        max={600}
        value={settings.returns}
        readOnly={readOnly}
        errors={props.errors(["returns"])}
        onChange={(returns) => set({ returns })}
      />
      <TextArea
        id={id(["sizing"])}
        label="Sizing advice"
        optional
        hint="The client's own advice, shown as typed. Leave it empty if they gave none."
        max={400}
        value={settings.sizing}
        readOnly={readOnly}
        errors={props.errors(["sizing"])}
        onChange={(sizing) => set({ sizing })}
      />
      <Checkbox
        id={id(["formerPricesConfirmed"])}
        label="The client confirmed their “was” prices"
        hint="Tick only when the client has said: “Each ‘was’ price is a price I actually charged for this item for a reasonable time recently.” Without it, no “was” price can be shown."
        checked={settings.formerPricesConfirmed}
        errors={props.errors(["formerPricesConfirmed"])}
        onChange={(formerPricesConfirmed) => (readOnly ? undefined : set({ formerPricesConfirmed }))}
      />
    </section>
  );
}
