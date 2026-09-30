import { useEffect, useRef } from "react";
import { loadTurnstile } from "../lib/turnstile.ts";
import { widgetSize } from "../lib/widget-size.ts";

/** The action the Worker requires (src/worker/turnstile.ts LOGIN_ACTION). */
const ACTION = "login";

/**
 * The sign-in form's Turnstile widget. `onToken` gets the token when the check passes and null when it
 * expires, fails or is reset. `resetSignal` resets the widget (tokens work once). With no sitekey, or if
 * the script cannot load, nothing is drawn and no token is ever produced: the Worker then refuses the
 * sign-in with its usual "Please complete the security check and try again." (fail closed).
 */
export function SecurityCheck({ onToken, resetSignal }: { onToken: (token: string | null) => void; resetSignal: number }) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<{ reset: () => void } | null>(null);
  const report = useRef(onToken);
  report.current = onToken;

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
      () => report.current(null),
    );
    return () => {
      live = false;
      widget.current = null;
      remove();
    };
  }, []);

  useEffect(() => {
    if (resetSignal > 0) widget.current?.reset();
  }, [resetSignal]);

  return <div ref={container} />;
}
