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
    <div role="tablist" aria-label={props.label} className="tab-list" onKeyDown={onKeyDown}>
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
            className="tab"
            onClick={() => props.onSelect(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
