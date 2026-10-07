import { useEffect, useRef, useState } from "react";
import { loadTurnstile } from "../lib/turnstile.ts";
import { widgetSize } from "../lib/widget-size.ts";

/** The action the Worker requires (src/worker/turnstile.ts LOGIN_ACTION). */
const ACTION = "login";

/**
 * The sign-in form's Turnstile widget. `onToken` gets the token when the check passes and null when it
 * expires, fails or is reset. `resetSignal` resets the widget (tokens work once). With no sitekey nothing
 * is drawn and no token is ever produced: the Worker then refuses the sign-in with its usual "Please
 * complete the security check and try again." (fail closed). If the script cannot load (a content blocker,
 * the network), the owner is told so and can try again, so they are never asked for a check that is not there.
 */
export function SecurityCheck({ onToken, resetSignal }: { onToken: (token: string | null) => void; resetSignal: number }) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<{ reset: () => void } | null>(null);
  const report = useRef(onToken);
  report.current = onToken;
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const target = container.current;
    if (target === null || __TURNSTILE_SITE_KEY__ === "") return;
    let live = true;
    let remove = () => {};
    loadTurnstile().then(
      (turnstile) => {
        if (!live) return;
        const id = turnstile.render(target, {
          sitekey: __TURNSTILE_SITE_KEY__,
          action: ACTION,
          size: widgetSize(target.getBoundingClientRect().width),
          callback: (token) => report.current(token),
          "error-callback": () => report.current(null),
          "expired-callback": () => report.current(null),
        });
        widget.current = { reset: () => turnstile.reset(id) };
        remove = () => turnstile.remove(id);
      },
      () => {
        if (!live) return;
        report.current(null);
        setLoadFailed(true);
      },
    );
    return () => {
      live = false;
      widget.current = null;
      remove();
    };
  }, [attempt]);

  useEffect(() => {
    if (resetSignal > 0) widget.current?.reset();
  }, [resetSignal]);

  return (
    <>
      <div ref={container} />
      {loadFailed ? (
        <div role="alert" className="mt-2">
          <p className="font-medium text-red-700">The security check didn't load. If you use an ad blocker, allow this page, then press Try again.</p>
          <button
            type="button"
            className="btn-secondary mt-2"
            onClick={() => {
              setLoadFailed(false);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
    </>
  );
}
