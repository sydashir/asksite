import { useState, type FormEvent } from "react";
import { api } from "../lib/api.ts";
import { NEW_PASSWORD_HINT, passwordProblem } from "../lib/password.ts";
import { Notice } from "./feedback.tsx";
import { PasswordInput } from "./fields.tsx";

/**
 * The account's password, on the signed-in home page (USER ORDER 2026-10-08): set the first one, or change it. Changing needs
 * the current one, unless this session signed in with an emailed link or an invite in the last 15 minutes (`skipCurrent`,
 * RULED 2026-10-08); the Worker decides, and if that window has just closed it says so and the current-password field appears.
 */
export function PasswordCard({ hasPassword, skipCurrent }: { hasPassword: boolean; skipCurrent: boolean }) {
  const [has, setHas] = useState(hasPassword);
  const [skip, setSkip] = useState(skipCurrent);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const askCurrent = has && !skip;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setCurrentError(null);
    setError(null);
    setSaved(false);
    const problem = passwordProblem(next);
    setNextError(problem);
    if (problem !== null) return;
    if (askCurrent && current === "") {
      setCurrentError("Enter your current password.");
      return;
    }
    setBusy(true);
    const res = await api("POST", "/api/me/password", askCurrent ? { currentPassword: current, newPassword: next } : { newPassword: next });
    setBusy(false);
    if (res.ok) {
      setHas(true);
      setCurrent("");
      setNext("");
      setSaved(true);
    } else if (res.status === 403 && !askCurrent) {
      // The 15 minutes after a link sign-in ended while the page was open: the current password is needed now.
      setSkip(false);
      setError(res.error.message);
    } else if (res.status === 403) setCurrentError(res.error.message);
    else setError(res.error.message);
  }

  return (
    <section className="card mt-8 max-w-xl" aria-labelledby="password-title">
      <h2 id="password-title" className="section-title">
        Your password
      </h2>
      <p className="meta mt-1">
        {!has
          ? "Set a password to log in with your email and password. You can still log in with a link we email you."
          : skip
            ? "You logged in with an email link, so you can set a new password without your current one."
            : "Change the password you log in with."}
      </p>
      <form noValidate onSubmit={(e) => void submit(e)}>
        {askCurrent ? (
          <PasswordInput
            id="current-password"
            label="Current password"
            hint="To set a new password without your current one, log in again with an email link."
            autoComplete="current-password"
            value={current}
            onChange={setCurrent}
            errors={currentError ? [currentError] : []}
          />
        ) : null}
        <PasswordInput
          id="new-password"
          label={has ? "New password" : "Password"}
          hint={NEW_PASSWORD_HINT}
          autoComplete="new-password"
          value={next}
          onChange={setNext}
          errors={nextError ? [nextError] : []}
        />
        {error !== null ? (
          <div role="alert">
            <Notice tone="error">{error}</Notice>
          </div>
        ) : null}
        <button type="submit" className="btn-primary mt-6" disabled={busy}>
          {busy ? "Saving…" : has ? "Change password" : "Set password"}
        </button>
        <div role="status">{saved ? <Notice tone="success">Your password is saved.</Notice> : null}</div>
      </form>
    </section>
  );
}
