import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * A native modal <dialog> (§9.2) that confirms a destructive or lasting action: the browser traps
 * focus and Escape closes it. Focus starts on Cancel, the safe choice (ARIA APG dialog pattern), and
 * the text is the dialog's description, so a screen reader reads it with the title.
 */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (props.open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      cancel.current?.focus();
    }
    if (!props.open && dialog.open) {
      dialog.close();
      // Back to the control that opened it; when the action removes that control, the page moves focus itself.
      opener.current?.focus();
    }
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-text`}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id={`${id}-title`} className="text-xl font-semibold tracking-[-0.015em] text-ink">
        {props.title}
      </h2>
      <div id={`${id}-text`} className="mt-3">
        {props.children}
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" className="btn-primary" onClick={props.onConfirm}>
          {props.confirmLabel}
        </button>
        <button ref={cancel} type="button" className="btn-secondary" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
