import { designForTrade, LOOKS, PAGE_DESIGNS, type OwnerEdits } from "@asksite/core";
import { FONTS, PALETTES } from "@asksite/renderer";
import { TRADES, type DesignId, type FontId, type Theme } from "@asksite/site-schema";
import type { ReactNode } from "react";

type Colors = Pick<Theme, "palette" | "font">;

const sameColors = (a: Colors, b: Colors): boolean => a.palette === b.palette && a.font === b.font;

/** One plain line for each page design (shown next to its name, until thumbnails exist). */
const DESIGN_BLURB: Record<DesignId, string> = {
  impact: "Big headlines and strong colors. Stands out.",
  refined: "Quiet and traditional, with room to breathe.",
  modern: "Light and clean, easy to scan on a phone.",
};

const LETTERING: Record<FontId, string> = { clean: "Clean lettering", sturdy: "Sturdy lettering", friendly: "Friendly lettering" };

function Swatch({ colors }: { colors: Colors }) {
  const palette = PALETTES[colors.palette];
  return (
    <span aria-hidden="true" className="flex gap-1">
      {[palette.primary, palette.secondary, palette.accent].map((color) => (
        <span key={color} className="size-6 rounded-full border border-slate-400" style={{ backgroundColor: color }} />
      ))}
    </span>
  );
}

/** One radio with its label box. `thumbnail` is a small picture of the design, for when thumbnails exist (decorative: the name says it all). */
function Option(props: { id: string; group: string; checked: boolean; readOnly: boolean; onChange: () => void; children: ReactNode; aside?: ReactNode; thumbnail?: string }) {
  return (
    <div className="choice-card">
      <input id={props.id} type="radio" name={props.group} className="size-6 shrink-0 accent-brand-800" checked={props.checked} aria-disabled={props.readOnly} onChange={props.onChange} />
      {props.thumbnail === undefined ? null : <img src={props.thumbnail} alt="" className="h-14 w-20 shrink-0 rounded border border-slate-300 object-cover object-top" />}
      <label htmlFor={props.id} className="flex flex-1 flex-wrap items-center justify-between gap-2">
        <span>{props.children}</span>
        {props.aside}
      </label>
    </div>
  );
}

/**
 * The page design (Bold, Classic, Modern) and the colors and lettering (the four looks, plus the AI's own choice when
 * it is none of them). Picking one changes only its own part of the theme: the writers merge into the current theme and
 * never write null, so the other part, and the AI's choice, are kept (A12).
 */
export function LookTab({ aiTheme, edits, trade, readOnly, setEdits }: { aiTheme: Theme; edits: OwnerEdits; trade: unknown; readOnly: boolean; setEdits: (edits: OwnerEdits) => void }) {
  const current: Theme = edits.theme ?? aiTheme;
  const recommendedDesign = typeof trade === "string" && (TRADES as readonly string[]).includes(trade) ? designForTrade(trade as (typeof TRADES)[number]) : null;
  const recommendedLook = LOOKS.find((look) => sameColors(look.theme, aiTheme));
  const colorOptions: Array<{ id: string; name: string; colors: Colors; recommended: boolean }> = [
    ...(recommendedLook === undefined ? [{ id: "recommended", name: "Recommended for you", colors: aiTheme, recommended: false }] : []),
    ...LOOKS.map((look) => ({ id: look.id, name: look.name, colors: look.theme, recommended: look === recommendedLook })),
  ];
  return (
    <div>
      <fieldset className="mt-4">
        <legend className="font-semibold">Page design</legend>
        <p className="mt-1 text-sm text-slate-600">How your page is laid out and drawn. Your words and photos stay.</p>
        <div className="mt-3 space-y-3">
          {PAGE_DESIGNS.map((design) => (
            <Option key={design.id} id={`design-${design.id}`} group="design" checked={current.design === design.id} readOnly={readOnly} onChange={() => setEdits({ ...edits, theme: { ...current, design: design.id } })}>
              <span className="font-medium">{design.name}</span>
              {design.id === recommendedDesign ? <span className="text-slate-600"> (recommended for you)</span> : null}
              <span className="block text-sm text-slate-600">{DESIGN_BLURB[design.id]}</span>
            </Option>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-6">
        <legend className="font-semibold">Colors and lettering</legend>
        <p className="mt-1 text-sm text-slate-600">Colors and fonts are checked to be easy to read for everyone.</p>
        <div className="mt-3 space-y-3">
          {colorOptions.map((option) => (
            <Option
              key={option.id}
              id={`colors-${option.id}`}
              group="colors"
              checked={sameColors(current, option.colors)}
              readOnly={readOnly}
              onChange={() => setEdits({ ...edits, theme: { ...current, palette: option.colors.palette, font: option.colors.font } })}
              aside={<Swatch colors={option.colors} />}
            >
              <span className="font-medium">{option.name}</span>
              {option.recommended ? <span className="text-slate-600"> (recommended for you)</span> : null}
              <span className="block text-sm text-slate-600" style={{ fontFamily: FONTS[option.colors.font].heading }}>
                {LETTERING[option.colors.font]}
              </span>
            </Option>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
