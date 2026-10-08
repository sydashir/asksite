import { RadioGroup, TextArea } from "../components/fields.tsx";
import { GOAL_OPTIONS, TONE_OPTIONS } from "../lib/labels.ts";
import { asString, fieldId } from "../lib/values.ts";
import type { StepProps } from "./types.ts";

export function WordsStep({ brief, setBrief, errors }: StepProps) {
  const optional = (v: string) => (v === "" ? undefined : v);
  return (
    <>
      <TextArea
        id={fieldId(["brief", "differentiator"])}
        label="What makes you different?"
        optional
        hint="One or two sentences, for example “We show up on time and clean up after ourselves.”"
        max={140}
        value={asString(brief["differentiator"])}
        errors={errors(["brief", "differentiator"])}
        onChange={(v) => setBrief(["differentiator"], optional(v))}
      />
      <RadioGroup
        id={fieldId(["brief", "tone"])}
        name="tone"
        label="How should your website sound?"
        options={TONE_OPTIONS}
        value={asString(brief["tone"])}
        errors={errors(["brief", "tone"])}
        onChange={(v) => setBrief(["tone"], v)}
      />
      <RadioGroup
        id={fieldId(["brief", "goal"])}
        name="goal"
        label="What should visitors do first?"
        options={GOAL_OPTIONS}
        value={asString(brief["goal"])}
        errors={errors(["brief", "goal"])}
        onChange={(v) => setBrief(["goal"], v)}
      />
      <TextArea
        id={fieldId(["brief", "notes"])}
        label="Anything else we should know?"
        optional
        hint="Pretend you are texting a friend who is building this website for you. What do you tell them so they do not get it wrong?"
        rows={5}
        max={2000}
        value={asString(brief["notes"])}
        errors={errors(["brief", "notes"])}
        onChange={(v) => setBrief(["notes"], optional(v))}
      />
    </>
  );
}
