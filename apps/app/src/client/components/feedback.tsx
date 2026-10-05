import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { navigate } from "../hooks/use-route.ts";
import type { SaverState } from "../lib/autosave.ts";
import { SAVING, saveAnnouncement } from "../lib/save-message.ts";

export interface SummaryItem {
  id: string;
  text: string;
  /** Set when the field is on another page: the link navigates there instead of focusing. */
  href?: string;
}

/**
 * "There is a problem" box, focused after a failed Continue or Publish (§9.2). Each link moves
 * focus to the field it names.
 */
export function ErrorSummary({ items, focusSignal }: { items: readonly SummaryItem[]; focusSignal: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusSignal > 0) ref.current?.focus();
  }, [focusSignal]);
  if (items.length === 0) return null;
  return (
    <div ref={ref} tabIndex={-1} className="mt-6 rounded-lg border-2 border-red-700 bg-red-50 p-4" aria-labelledby="error-summary-title">
      <h2 id="error-summary-title" className="font-semibold text-red-800">
        {items.length === 1 ? "There is 1 thing to fix" : `There are ${items.length} things to fix`}
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {items.map((item, i) => (
          <li key={`${item.id}-${i}`}>
            <a
              href={item.href ?? `#${item.id}`}
              className="text-red-800 underline"
              onClick={(e) => {
                e.preventDefault();
                if (item.href !== undefined) navigate(item.href);
                else document.getElementById(item.id)?.focus();
              }}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Autosave status. Only settled states are announced, so typing does not flood screen readers. The wording notice stays up through
 * every later save until the owner dismisses it (onDismiss) or tries to leave twice; a failed save still shows its own warning first.
 * `messageRef` lets the page move focus to the message when it stops an action for it.
 */
export function SaveStatus({
  state,
  onRetry,
  onReload,
  onDismiss,
  messageRef,
}: {
  state: SaverState;
  onRetry: () => void;
  onReload: () => void;
  onDismiss?: () => void;
  messageRef?: RefObject<HTMLParagraphElement | null>;
}) {
  const failed = state.status === "error" || state.status === "conflict";
  const dropped = state.wordingDropped === true && !failed;
  const announce = saveAnnouncement(state);
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <p ref={messageRef} tabIndex={-1} role="status" className={failed ? "font-medium text-red-700" : dropped ? "font-medium text-slate-900" : "text-slate-700"}>
        {announce}
      </p>
      {state.status === "pending" || state.status === "saving" ? (
        <p aria-hidden="true" className="text-slate-700">
          {SAVING}
        </p>
      ) : null}
      {dropped && onDismiss !== undefined ? (
        <button type="button" className="btn-secondary" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
      {state.status === "error" ? (
        <button type="button" className="btn-secondary" onClick={onRetry}>
          Try again
        </button>
      ) : null}
      {state.status === "conflict" ? (
        <button type="button" className="btn-secondary" onClick={onReload}>
          Reload
        </button>
      ) : null}
    </div>
  );
}

export function Notice({ tone, children }: { tone: "info" | "warning" | "success" | "error"; children: ReactNode }) {
  const style = {
    info: "border-blue-700 bg-blue-50 text-slate-900",
    warning: "border-amber-700 bg-amber-50 text-slate-900",
    success: "border-green-700 bg-green-50 text-slate-900",
    error: "border-red-700 bg-red-50 text-slate-900",
  }[tone];
  return <div className={`mt-4 rounded-lg border-l-4 p-4 ${style}`}>{children}</div>;
}
