import { useEffect } from "react";
import { Select, TextInput } from "../components/fields.tsx";
import { phoneInput, phoneToFacts } from "../lib/facts-form.ts";
import { TRADE_OPTIONS, US_STATES } from "../lib/labels.ts";
import { asRecord, asString, fieldId } from "../lib/values.ts";
import type { StepProps } from "./types.ts";

const optional = (value: string): string | undefined => (value === "" ? undefined : value);

export function BusinessStep({ facts, setFacts, errors, ownerEmail }: StepProps) {
  // The public email starts as the sign-in email, so the owner never types it twice (WCAG 3.3.7).
  useEffect(() => {
    if (facts["email"] === undefined && ownerEmail !== null) setFacts(["email"], ownerEmail);
  }, [facts, ownerEmail, setFacts]);

  const location = asRecord(facts["location"]);
  const field = (...path: string[]) => ({ id: fieldId(["facts", ...path]), errors: errors(["facts", ...path]) });
  return (
    <>
      <TextInput {...field("businessName")} label="Business name" autoComplete="organization" max={60} value={asString(facts["businessName"])} onChange={(v) => setFacts(["businessName"], v)} />
      <Select {...field("trade")} label="What kind of work do you do?" options={TRADE_OPTIONS} value={asString(facts["trade"])} onChange={(v) => setFacts(["trade"], optional(v))} />
      <TextInput
        {...field("phone")}
        label="Business phone number"
        hint="Shown on your website and used by its call button."
        type="tel"
        autoComplete="tel-national"
        inputMode="tel"
        value={phoneInput(facts["phone"])}
        onChange={(v) => setFacts(["phone"], optional(phoneToFacts(v)))}
      />
      <TextInput
        {...field("email")}
        label="Business email address"
        hint="Shown on your website. Messages from your contact form always go to the email you sign in with."
        type="email"
        autoComplete="email"
        value={asString(facts["email"])}
        onChange={(v) => setFacts(["email"], v)}
      />
      <TextInput {...field("location", "city")} label="City" autoComplete="address-level2" max={40} value={asString(location["city"])} onChange={(v) => setFacts(["location", "city"], v)} />
      <Select {...field("location", "state")} label="State" autoComplete="address-level1" options={US_STATES} value={asString(location["state"])} onChange={(v) => setFacts(["location", "state"], optional(v))} />
      <TextInput
        {...field("location", "streetAddress")}
        label="Street address"
        optional
        hint="Leave empty if customers do not visit you."
        autoComplete="street-address"
        max={80}
        value={asString(location["streetAddress"])}
        onChange={(v) => setFacts(["location", "streetAddress"], optional(v))}
      />
      <TextInput
        {...field("location", "postalCode")}
        label="ZIP code"
        optional
        autoComplete="postal-code"
        inputMode="numeric"
        value={asString(location["postalCode"])}
        onChange={(v) => setFacts(["location", "postalCode"], optional(v))}
      />
    </>
  );
}
