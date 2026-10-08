import { useState, type FormEvent } from "react";
import { TextInput } from "../../../app/src/client/components/fields.tsx";

/**
 * The owner-disable form keeps its own reason (THE RULE, see TakedownForms.tsx): the page keys it by the owner's state (`site.ownerDisabled`, the only
 * owner-state field the site API returns), and it empties its reason after every answer, success or error.
 * `onDisable` resolves when the call has answered. `busy`: an admin action is running, so a press is ignored (as in TakedownForms.tsx).
 */
export function OwnerDisableForm({ busy, onDisable }: { busy: boolean; onDisable: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (reason.trim() === "") {
      setErrors(["Write the reason. It is kept in the audit log."]);
      document.getElementById("disable-reason")?.focus();
      return;
    }
    setErrors([]);
    await onDisable(reason.trim());
    setReason("");
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)}>
      <TextInput id="disable-reason" label="Reason for disabling the owner" value={reason} onChange={setReason} errors={errors} />
      <button type="submit" className="btn-danger mt-3" aria-disabled={busy}>
        Disable the owner
      </button>
    </form>
  );
}
