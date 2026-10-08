import { useState, type FormEvent } from "react";
import { ConfirmDialog } from "../../../app/src/client/components/dialog.tsx";
import { TextInput } from "../../../app/src/client/components/fields.tsx";
import { confirmEmailProblem, deleteDialogText } from "./lib/format.ts";

/**
 * Delete the account (spec §7.7), shown only while the owner is disabled. Two steps: the owner's email typed back (checked here first; a wrong one sends
 * nothing), then a dialog that names the site count. `onDelete` sends the call and resolves with the field error the server gave (the email differs), or null.
 * `unfinished`: an earlier press did not finish (a 5xx, a lost lease or no connection), so the only control is "Finish deleting the account", which sends the
 * same body again. `busy`: a delete call is running, so a press is ignored.
 */
export function OwnerDeleteForm(props: {
  ownerEmail: string;
  siteCount: number;
  busy: boolean;
  unfinished: boolean;
  onDelete: (confirmEmail: string) => Promise<string | null>;
  onFinish: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);

  function ask(event: FormEvent) {
    event.preventDefault();
    if (props.busy) return;
    const problem = confirmEmailProblem(typed, props.ownerEmail);
    if (problem !== null) {
      setErrors([problem]);
      document.getElementById("delete-email")?.focus();
      return;
    }
    setErrors([]);
    setConfirming(true);
  }

  async function confirm() {
    setConfirming(false);
    if (props.busy) return;
    const fieldError = await props.onDelete(typed.trim());
    if (fieldError !== null) {
      setErrors([fieldError]);
      document.getElementById("delete-email")?.focus();
    }
  }

  if (props.unfinished) {
    return (
      <button type="button" className="btn-primary mt-3" aria-disabled={props.busy} onClick={() => (props.busy ? undefined : void props.onFinish())}>
        Finish deleting the account
      </button>
    );
  }

  return (
    <>
      <form noValidate onSubmit={ask}>
        <TextInput id="delete-email" label="Type the owner's email to delete the account" type="email" autoComplete="off" value={typed} onChange={setTyped} errors={errors} />
        <button type="submit" className="btn-secondary mt-3" aria-disabled={props.busy}>
          Delete the account
        </button>
      </form>
      <ConfirmDialog open={confirming} title="Delete this account?" confirmLabel="Delete everything" onCancel={() => setConfirming(false)} onConfirm={() => void confirm()}>
        <p>{deleteDialogText(props.ownerEmail, props.siteCount)}</p>
      </ConfirmDialog>
    </>
  );
}
