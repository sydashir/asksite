import { useState, type FormEvent } from "react";
import { ConfirmDialog } from "../../../app/src/client/components/dialog.tsx";
import { Checkbox, TextArea, TextInput } from "../../../app/src/client/components/fields.tsx";

/** `expectedTakenDownAt` is sent only by Finish the takedown: the moment its form was opened for (the server refuses a site restored since). */
export type TakedownBody = { reason: string; ownerMessage?: string; purgeMedia: boolean; expectedTakenDownAt?: number };

/** Sends the takedown call and runs `answered` the moment its answer arrives (success or error), before the page reloads: the form resets there, so text typed after the answer is never wiped. */
export type SendTakedown = (body: TakedownBody, answered: () => void) => Promise<void>;

/** The takedown reason's limit (core's TakedownBody): longer is refused here, in words, before anything is sent. It counts code points of the trimmed text, as zod's .max does. */
const REASON_MAX = 1000;
/** What is wrong with a takedown reason, or null. */
const reasonProblem = (value: string): string | null =>
  value.trim() === "" ? "Write the reason. It is kept in the audit log." : [...value.trim()].length > REASON_MAX ? `Please use ${REASON_MAX} characters or fewer.` : null;

/*
 * THE RULE (DECIDED 2026-10-07): "Every admin action form is opened for ONE site state. Its fields are born empty and unticked for that state, and reset
 * after every answer. Nothing typed or ticked for one takedown can reach another."
 * Both forms keep their own fields. The page keys each one by the state it was opened for (a different state remounts it, empty and unticked), and each
 * resets after every answer, success or error. React keeps a component's state while its key stays the same and discards it when the key changes
 * (react.dev, "Preserving and Resetting State").
 */

/** The up-site form: takes the site down. `busy`: a takedown call is running, so a press is ignored. */
export function TakedownForm({ busy, onTakeDown }: { busy: boolean; onTakeDown: SendTakedown }) {
  const [reason, setReason] = useState("");
  const [ownerMessage, setOwnerMessage] = useState("");
  const [purge, setPurge] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);

  function ask(event: FormEvent) {
    event.preventDefault();
    const problem = reasonProblem(reason);
    if (problem !== null) {
      setErrors([problem]);
      document.getElementById("takedown-reason")?.focus();
      return;
    }
    setErrors([]);
    setConfirming(true);
  }

  function confirm() {
    setConfirming(false);
    if (busy) return;
    void onTakeDown({ reason: reason.trim(), ownerMessage: ownerMessage.trim(), purgeMedia: purge }, () => {
      setReason("");
      setOwnerMessage("");
      setPurge(false);
    });
  }

  return (
    <>
      <form noValidate onSubmit={ask}>
        <TextInput id="takedown-reason" label="Reason for taking it down" max={REASON_MAX} value={reason} onChange={setReason} errors={errors} />
        <TextArea id="takedown-message" label="Message to the owner" optional max={1000} value={ownerMessage} onChange={setOwnerMessage} />
        <Checkbox id="takedown-purge" label="Also delete this site's photos" checked={purge} onChange={setPurge} />
        <button type="submit" className="btn-secondary mt-3">
          Take the site down
        </button>
      </form>
      <ConfirmDialog open={confirming} title="Take this site down?" confirmLabel="Take it down" onCancel={() => setConfirming(false)} onConfirm={confirm}>
        <p>The page stops being served within about a minute{purge ? ", and its photos are deleted" : ""}.</p>
      </ConfirmDialog>
    </>
  );
}

/** The down-site form: runs the takedown again for the takedown at `takenDownAt` (its own reason and photos choice, and no owner message: a re-run sends no notice). */
export function FinishForm({ takenDownAt, busy, onFinish }: { takenDownAt: number; busy: boolean; onFinish: SendTakedown }) {
  const [reason, setReason] = useState("");
  const [purge, setPurge] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const problem = reasonProblem(reason);
    if (problem !== null) {
      setErrors([problem]);
      document.getElementById("finish-reason")?.focus();
      return;
    }
    setErrors([]);
    void onFinish({ reason: reason.trim(), purgeMedia: purge, expectedTakenDownAt: takenDownAt }, () => {
      setReason("");
      setPurge(false);
    });
  }

  return (
    <form noValidate onSubmit={submit} className="mt-4">
      <TextInput id="finish-reason" label="Reason for finishing the takedown" max={REASON_MAX} value={reason} onChange={setReason} errors={errors} />
      <Checkbox id="finish-purge" label="Also delete this site's photos" checked={purge} onChange={setPurge} />
      <button type="submit" className="btn-secondary mt-3" aria-disabled={busy}>
        Finish the takedown
      </button>
    </form>
  );
}
