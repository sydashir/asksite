import type { ComposedDocument, CurrentAi, OwnerEdits } from "@asksite/core";
import { PAGES, type SectionId } from "@asksite/site-schema";
import { focusFirstEnabled } from "../steps/types.ts";
import { editsForAi } from "../lib/edits.ts";
import { canMove, isHideable, listedSections, moveSection, pageRemovedByHiding, SECTION_LABEL, sectionsByPage, setHidden } from "../lib/sections.ts";

interface Props {
  ai: CurrentAi;
  /** The always-current composed draft (valid or not), so every move builds on the one before it. */
  composed: ComposedDocument;
  edits: OwnerEdits;
  setEdits: (edits: OwnerEdits) => void;
  /** The AI's wording is not fresh: nothing here may change (aria-disabled, so keyboard focus stays; the editor also drops the edit). */
  readOnly: boolean;
  /** Hiding a section never depends on the wording, so it is locked only when the AI's wording is not fresh, not while new wording is being written. */
  hideReadOnly: boolean;
  setHiddenEdits: (edits: OwnerEdits) => void;
  /** The owner changed this section: the preview shows its page. */
  onSection: (section: SectionId) => void;
}

const moveId = (id: SectionId, direction: "up" | "down") => `section-move-${id}-${direction}`;

/**
 * Order and hide sections with buttons, never drag (WCAG 2.5.7). Grouped by the page each section lives on: a section
 * moves up and down only within its own page (U1). Hero, services and contact always show.
 */
export function SectionsTab({ ai, composed, edits, setEdits, readOnly, hideReadOnly, setHiddenEdits, onSection }: Props) {
  const listed = listedSections(composed);
  const order = composed.layout.map((s) => s.id);
  const move = (id: SectionId, by: -1 | 1) => {
    onSection(id);
    setEdits({ ...editsForAi(ai, edits), order: moveSection(order, listed, id, by) });
    // A button that reached the edge of its page is disabled: keep keyboard focus on this section's other Move button.
    focusFirstEnabled(moveId(id, by === -1 ? "up" : "down"), moveId(id, by === -1 ? "down" : "up"));
  };
  return (
    <div className="mt-4">
      <h2 className="font-semibold">Sections on your pages</h2>
      <p className="mt-1 text-sm text-slate-600">Sections only appear when they have something to show. A section moves up and down on its own page.</p>
      {sectionsByPage(order, listed).map(({ page, sections }) => (
        <section key={page} aria-labelledby={`sections-${page}`} className="mt-5">
          <h3 id={`sections-${page}`} className="font-semibold text-slate-900">
            {PAGES[page].label} page
          </h3>
          <ol className="mt-2 space-y-3">
            {sections.map((id) => {
              const hidden = (edits.hidden as readonly string[]).includes(id);
              const removes = hidden ? null : pageRemovedByHiding(listed, edits.hidden, id);
              return (
                <li key={id} className="rounded-lg border border-slate-300 bg-white p-3">
                  <p className="font-medium">
                    {SECTION_LABEL[id]}
                    {hidden ? <span className="font-normal text-slate-600"> (hidden)</span> : null}
                  </p>
                  {id === "hero" ? null : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button id={moveId(id, "up")} type="button" className="btn-small" disabled={!canMove(order, listed, id, -1)} aria-disabled={readOnly} onClick={() => move(id, -1)}>
                        Move {SECTION_LABEL[id]} up
                      </button>
                      <button id={moveId(id, "down")} type="button" className="btn-small" disabled={!canMove(order, listed, id, 1)} aria-disabled={readOnly} onClick={() => move(id, 1)}>
                        Move {SECTION_LABEL[id]} down
                      </button>
                    </div>
                  )}
                  {isHideable(id) ? (
                    <div className="mt-2">
                      <div className="flex items-center gap-3">
                        <input
                          id={`hide-${id}`}
                          type="checkbox"
                          className="size-6 accent-blue-700"
                          checked={hidden}
                          aria-disabled={hideReadOnly}
                          aria-describedby={removes === null ? undefined : `hide-${id}-note`}
                          onChange={(e) => {
                            // Hiding a section that takes its page away leaves nothing to show there: the preview says so itself.
                            if (!e.target.checked || removes === null) onSection(id);
                            setHiddenEdits({ ...edits, hidden: setHidden(edits.hidden, id, e.target.checked) });
                          }}
                        />
                        <label htmlFor={`hide-${id}`}>Hide {SECTION_LABEL[id]}</label>
                      </div>
                      {removes === null ? null : (
                        <p id={`hide-${id}-note`} className="mt-1 text-sm text-slate-600">
                          Hiding this also removes the {PAGES[removes].label} page from your menu.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-slate-600">Always shown: visitors need to know what you do and how to reach you.</p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
