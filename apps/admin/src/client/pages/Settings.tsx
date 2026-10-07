import { useEffect, useState, type FormEvent } from "react";
import { Checkbox, TextInput } from "../../../../app/src/client/components/fields.tsx";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { usePageHeading } from "../../../../app/src/client/hooks/use-page-heading.ts";
import { api } from "../../../../app/src/client/lib/api.ts";
import type { SettingsView, SignInEmailsView } from "../../settings-view.ts";
import { useResource } from "../hooks.ts";
import { spentTodayText, worstCaseText } from "../lib/format.ts";

/** The AI kill switch and daily model limit, with today's usage and the worst case (§3.2 step 5, §6.3). */
export function Settings() {
  const heading = usePageHeading<HTMLHeadingElement>("Settings", "Admin");
  const { load, reload } = useResource<SettingsView>("/api/admin/settings");
  const signIn = useResource<SignInEmailsView>("/api/admin/sign-in-emails").load;
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [limit, setLimit] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (load.state !== "ready") return;
    setSettings(load.data);
    setEnabled(load.data.generationEnabled);
    setLimit(String(load.data.dailyModelLimit));
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const value = Number(limit);
    if (!/^\d+$/.test(limit.trim()) || value > 1000) {
      setErrors(["Enter a whole number from 0 to 1000."]);
      document.getElementById("daily-limit")?.focus();
      return;
    }
    if (settings === null) return;
    setErrors([]);
    // Only what this admin changed, compared with what the page loaded: another admin may have changed the other setting since (the AI kill switch
    // must not be switched back on by a save that only touched the limit). The API accepts either field alone.
    const changes = {
      ...(enabled === settings.generationEnabled ? {} : { generationEnabled: enabled }),
      ...(value === settings.dailyModelLimit ? {} : { dailyModelLimit: value }),
    };
    if (Object.keys(changes).length === 0) {
      // Nothing changed against what the page loaded: send nothing. The reload shows what the server holds now (another admin may have changed it).
      await reload();
      setMessage({ tone: "success", text: "Nothing to save." });
      return;
    }
    const res = await api<SettingsView>("PUT", "/api/admin/settings", changes);
    if (res.ok) {
      await reload(); // the form shows what the server holds now, including any change another admin made
      setMessage({ tone: "success", text: "Settings saved." });
    } else setMessage({ tone: "error", text: res.error.message });
  }

  return (
    <section className="max-w-2xl">
      <h1 ref={heading} tabIndex={-1} className="page-title">
        Settings
      </h1>
      {load.state === "error" ? <Notice tone="error">{load.error.message}</Notice> : null}
      {settings !== null ? (
        <>
          <dl className="card mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="font-medium">AI writing calls today</dt>
            <dd>
              {settings.modelCallsToday} of {settings.dailyModelLimit}
            </dd>
            <dt className="font-medium">Spent today</dt>
            <dd>{spentTodayText(settings.spentTodayMicrousd, settings.modelCallsToday, settings.unknownCostJobsToday)}</dd>
            <dt className="font-medium">Most it can cost per day</dt>
            <dd>{worstCaseText(settings.worstCaseDailyMicrousd)}</dd>
            {signIn.state === "ready" ? (
              <>
                <dt className="font-medium">Sign-in emails today</dt>
                <dd>
                  {signIn.data.sentToday} of {signIn.data.dailyCap}
                </dd>
              </>
            ) : null}
          </dl>
          {signIn.state === "ready" && signIn.data.capReachedAt !== null ? (
            <Notice tone="warning">Sign-in emails are paused until midnight UTC (daily limit reached at {new Date(signIn.data.capReachedAt).toISOString().slice(11, 16)} UTC)</Notice>
          ) : null}
          {signIn.state === "error" ? <Notice tone="error">{signIn.error.message}</Notice> : null}
          {!settings.envGenerationEnabled ? <Notice tone="warning">AI writing is switched off in the server settings (GENERATION_ENABLED), whatever this page says.</Notice> : null}
          <form className="card mt-4" noValidate onSubmit={(e) => void save(e)}>
            <Checkbox id="generation-enabled" label="AI writing is on" hint="When off, new sites get starter wording and “Write new wording” is refused." checked={enabled} onChange={setEnabled} />
            <TextInput id="daily-limit" label="Most AI writing jobs per day, for all owners" inputMode="numeric" value={limit} onChange={setLimit} errors={errors} />
            <button type="submit" className="btn-primary mt-4">
              Save settings
            </button>
          </form>
          <div role="status">{message !== null ? <Notice tone={message.tone}>{message.text}</Notice> : null}</div>
        </>
      ) : null}
    </section>
  );
}
