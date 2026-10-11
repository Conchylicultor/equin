import { useMemo, type ReactNode } from "react";
import { useChordAudition } from "@plugins/apps/plugins/sonata/plugins/audio/plugins/live-play/web";
import {
  ChordBox,
  chordColour,
  chordToneStyle,
  type ChordBoxLabel,
} from "@plugins/music/plugins/chord-box/web";
import type { MajorDegree } from "@plugins/music/plugins/chord-box/core";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ReadoutKeyboard, type ReadoutPlane } from "./readout-keyboard";
import "./chord-keyboard-row.css";

/**
 * One chord as the rich sections list it: its chord box, a readout keyboard lit
 * with its notes in the chord's colour, and a short trail (a count, or nothing).
 * The whole row is a button that sounds the chord — exactly the notes its
 * keyboard lights — then runs `onPick` (e.g. seek to it). `now` marks the chord
 * under the playhead: a wash on the row and the box's own ring.
 *
 * The chord list and the current key's diatonic chords both draw this row, so a
 * chord looks — and answers a click — the same wherever it is listed.
 */
export function ChordKeyboardRow({
  degree,
  label,
  name,
  plane,
  notes,
  now = false,
  trail,
  description,
  onPick,
}: {
  /** The root's major-scale degree, which paints the box and lights the keys; `null` paints grey. */
  degree: MajorDegree | null;
  label: ChordBoxLabel;
  /** The chord's name, for the accessible label. */
  name: string;
  /** The shared plane every row of the list is drawn on (`useReadoutPlane`). */
  plane: ReadoutPlane;
  /** The chord's pitches, already fitted to `plane`. */
  notes: readonly number[];
  now?: boolean;
  trail?: ReactNode;
  /** What the click does beyond sounding the chord, for the accessible label (e.g. "go to its first time"). */
  description?: string;
  onPick?: () => void;
}) {
  const audition = useChordAudition();
  const lit = useMemo(() => {
    const colour = chordColour(degree);
    return new Map(notes.map((p) => [p, colour]));
  }, [notes, degree]);
  return (
    <Overlay
      className="chord-row"
      style={chordToneStyle(degree)}
      data-now={now ? "" : undefined}
      clickThrough
      behind={
        <button
          type="button"
          className="chord-row-hit size-full"
          aria-label={
            description === undefined
              ? `${name} — play it`
              : `${name} — play it and ${description}`
          }
          aria-current={now ? "true" : undefined}
          onClick={() => {
            audition?.(notes);
            onPick?.();
          }}
        />
      }
    >
      <ChordRowFrame
        lead={
          <ChordBox
            className="chord-row-box"
            degree={degree}
            state="filled"
            label={label}
            now={now}
          />
        }
        trail={trail}
      >
        <ReadoutKeyboard plane={plane} lit={lit} />
      </ChordRowFrame>
    </Overlay>
  );
}

/**
 * The chord row's three columns — lead (the chord box's width), keyboard, trail
 * — so a keyboard drawn outside a chord row (the current key's scale) lines up
 * key-for-key with the rows under it. Either side may be empty.
 */
export function ChordRowFrame({
  lead,
  trail,
  children,
}: {
  lead?: ReactNode;
  trail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="chord-row-cells">
      {lead ?? <span />}
      {children}
      <Text variant="caption" tone="muted" className="tabular-nums">
        {trail}
      </Text>
    </div>
  );
}
