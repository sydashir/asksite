import { useRef, type KeyboardEvent } from "react";

/** ARIA tabs: arrow keys, Home and End move between tabs; only the selected tab is in the Tab order. */
export function Tabs<T extends string>(props: {
  label: string;
  idPrefix: string;
  tabs: ReadonlyArray<{ id: T; label: string }>;
  selected: T;
  onSelect: (id: T) => void;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = props.tabs.findIndex((t) => t.id === props.selected);
    const last = props.tabs.length - 1;
    const target =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    const tab = props.tabs[target]!;
    props.onSelect(tab.id);
    refs.current.get(tab.id)?.focus();
  };
  return (
    <div role="tablist" aria-label={props.label} className="flex flex-wrap gap-1 border-b border-slate-300" onKeyDown={onKeyDown}>
      {props.tabs.map((tab) => {
        const selected = tab.id === props.selected;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) refs.current.set(tab.id, el);
            }}
            type="button"
            role="tab"
            id={`${props.idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${props.idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            className={
              selected
                ? "-mb-px min-h-11 rounded-t-md border border-b-white border-slate-300 bg-white px-4 font-semibold text-blue-800"
                : "min-h-11 rounded-t-md px-4 text-slate-800 hover:bg-slate-100"
            }
            onClick={() => props.onSelect(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
