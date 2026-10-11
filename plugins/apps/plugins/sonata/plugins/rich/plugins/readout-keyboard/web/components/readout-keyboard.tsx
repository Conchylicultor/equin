import { useMemo, type ReactNode } from "react";
import {
  Keyboard,
  useSonataKeySkin,
  type KeyboardProps,
} from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/keyboard/web";
import { usePitchGeometry } from "@plugins/apps/plugins/sonata/plugins/pitch-layout/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { fitVoicings } from "../../core";

/** The plane a list of readout keyboards shares. */
export type ReadoutPlane = KeyboardProps["plane"];

/**
 * The plane a set of readout keyboards is drawn on, and the voicings to light on
 * it: the voicings octave-fitted into the readout window ({@link fitVoicings}),
 * laid in the active pitch layout. One plane for every row — they differ only in
 * what is lit, so they share one frame.
 *
 * Pass a memoized `voicings` array: the fit recomputes when its identity changes.
 */
export function useReadoutPlane(voicings: readonly (readonly number[])[]): {
  plane: ReadoutPlane;
  voicings: number[][];
} {
  const fitted = useMemo(() => fitVoicings(voicings), [voicings]);
  const plane = usePitchGeometry(fitted.low, fitted.high);
  return { plane, voicings: fitted.voicings };
}

/**
 * A readout keyboard: the one keyboard shape the rich sections draw — keys kept
 * in proportion at any width (a narrower keyboard is shorter, never squashed),
 * painted in Sonata's look.
 */
export function ReadoutKeyboard({
  plane,
  lit,
  renderKey,
}: {
  plane: ReadoutPlane;
  lit: KeyboardProps["lit"];
  renderKey?: KeyboardProps["renderKey"];
}) {
  const skin = useSonataKeySkin();
  return (
    <Keyboard
      plane={plane}
      lit={lit}
      skin={skin}
      renderKey={renderKey}
      sizing="proportional"
    />
  );
}

/**
 * The caption row above a readout keyboard: a lead (an inversion's ordinal, a
 * diatonic chord's numeral) at the left, a trail (the chord's symbol) at the
 * right, in small muted caption type. The trail takes the primary tone when the
 * row is the current one (the chord under the playhead).
 */
export function KeyboardCaption({
  lead,
  trail,
  current = false,
}: {
  lead: ReactNode;
  trail: ReactNode;
  current?: boolean;
}) {
  return (
    <Line>
      <Text variant="caption" tone="muted">
        {lead}
      </Text>
      <Fill />
      <Text variant="caption" tone={current ? "primary" : "muted"}>
        {trail}
      </Text>
    </Line>
  );
}
