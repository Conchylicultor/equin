import type React from "react";
import type { ReactNode } from "react";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import type { ScaleDegree } from "../../core";
import { chordPaint, type ChordPaint } from "../chord-paint";
import { chordToneStyle } from "../chord-tone";
import { ChordNumeral } from "./chord-numeral";
import "../chord-box.css";

/** What a chord box says. */
export type ChordBoxLabel =
  /** The numeral first, the chord's name under it. */
  | {
      primary: "numeral";
      numeral: string;
      mark: string;
      name?: string;
    }
  /** The chord's name (its symbol) first, the numeral under it. */
  | {
      primary: "name";
      /** The name's head — the root, `C`, `F♯` — or the whole symbol. */
      name: string;
      /** The rest of the symbol, set small and raised after the head as a numeral's mark is: `maj7`, `m7♭5`, `/E`. */
      mark?: string;
      numeral?: { numeral: string; mark: string };
    };

/** The full-bleed button behind a box's content: the whole box is its target. */
export interface ChordBoxHit {
  onClick: () => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Set for a box that toggles (a selectable answer); omit for a plain action. */
  pressed?: boolean;
}

export interface ChordBoxProps extends Passthrough<HTMLDivElement> {
  /** The numeral's number (`rootReading`'s degree), which paints the box; `null` (no key) paints grey. */
  degree: ScaleDegree | null;
  /**
   * `filled` — the solid tile; `given` — the chord printed dimmed and flat
   * (the quiet tint); `empty` — a dashed edge waiting for a chord (the ghost).
   */
  state: "filled" | "given" | "empty";
  /** Absent: no text (a held tie, an empty answer). */
  label?: ChordBoxLabel;
  /** The chord sounding now: lifted and ringed in its colour. */
  now?: boolean;
  selected?: boolean;
  hit?: ChordBoxHit;
  /** Replaces the label as the box's content (laid out in the same centred column). */
  children?: ReactNode;
  /** Drawn over the frame, outside the content column — a corner badge, placed by its caller. */
  adornment?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/** The paint each box state wears. */
const STATE_PAINT: Record<ChordBoxProps["state"], ChordPaint> = {
  filled: "tile",
  given: "tint-quiet",
  empty: "ghost",
};

/**
 * A chord drawn as a box: a frame painted in its degree's colour (the
 * chord-palette tokens), holding its numeral and name. Its size comes from
 * where it sits — the numeral scales with the box's width.
 *
 * The click target is the full-bleed `hit` button BEHIND the content, so the
 * content can hold buttons of its own (wrap them in `<Overlay.Interactive>`).
 * Surface-only states (a checked mark, a fill's pop) are `data-*` attributes
 * passed through to the frame, painted by the surface.
 */
export function ChordBox({
  degree,
  state,
  label,
  now = false,
  selected = false,
  hit,
  children,
  adornment,
  className,
  style,
  ref,
  ...rest
}: ChordBoxProps) {
  const content =
    children ?? (label === undefined ? null : <Label label={label} />);
  return (
    <div
      ref={ref}
      className={cn(
        "chord-box relative",
        chordPaint(STATE_PAINT[state]),
        className,
      )}
      style={{ ...style, ...chordToneStyle(degree) }}
      data-filled={state === "filled" ? "" : undefined}
      data-given={state === "given" ? "" : undefined}
      data-selected={selected ? "" : undefined}
      data-now={now ? "" : undefined}
      {...rest}
    >
      <Overlay
        fill
        clickThrough
        className="size-full"
        behind={
          hit === undefined ? undefined : (
            <button
              type="button"
              className="chord-box-hit size-full"
              disabled={hit.disabled}
              aria-label={hit.ariaLabel}
              aria-pressed={hit.pressed}
              onClick={hit.onClick}
            />
          )
        }
      >
        <Stack gap="xs" align="center" justify="center" className="size-full">
          {content}
        </Stack>
      </Overlay>
      {adornment}
    </div>
  );
}

function Label({ label }: { label: ChordBoxLabel }) {
  if (label.primary === "numeral") {
    return (
      <>
        <ChordNumeral numeral={label.numeral} mark={label.mark} />
        {label.name !== undefined && (
          <span className="chord-box-name">{label.name}</span>
        )}
      </>
    );
  }
  return (
    <>
      <span className="chord-box-symbol">
        {label.name}
        {label.mark !== undefined && label.mark !== "" && (
          <span className="chord-box-symbol-mark">{label.mark}</span>
        )}
      </span>
      {label.numeral !== undefined && (
        <ChordNumeral
          numeral={label.numeral.numeral}
          mark={label.numeral.mark}
          className="chord-box-name"
        />
      )}
    </>
  );
}
