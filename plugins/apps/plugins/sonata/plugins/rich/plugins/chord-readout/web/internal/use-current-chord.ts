import { useMemo } from "react";
import {
  useCursorSelector,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  DEFAULT_DRAFT_TTL,
  legacyDraftKeys,
  useDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import type {
  Annotation,
  ChordData,
} from "@plugins/apps/plugins/sonata/plugins/score/core";

/**
 * The chord annotation under the playhead — `undefined` in a gap between chords
 * (or past the last one). Before playback starts (cursor at 0) it is the first
 * chord, so the section isn't blank on load.
 *
 * Shared by the section body and its header action, so the readout and the
 * Inversions toggle can never disagree about which chord is current.
 *
 * `useCursorSelector` returns the matched chord's STABLE reference (from the
 * memoized `chords` array), so a caller re-renders only when the chord under
 * the playhead changes — not on every cursor frame.
 */
export function useCurrentChord(): Annotation<"chord", ChordData> | undefined {
  const { score } = useSession();
  const chords = useMemo(
    () =>
      score.annotations.filter(
        (a): a is Annotation<"chord", ChordData> => a.type === "chord",
      ),
    [score.annotations],
  );
  return useCursorSelector(
    (cursorBeat) =>
      chords.find((c) => cursorBeat >= c.start && cursorBeat < c.end) ??
      (cursorBeat <= 0 ? chords[0] : undefined),
    [chords],
  );
}

const inversionsStore = defineStore({
  owner: "sonata.chord-readout-inversions",
  label: "Sonata layout preferences",
  area: "local",
  cap: "1 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.boolean(),
  legacy: legacyDraftKeys("sonata:chord-readout:inversions"),
});

/** Whether the section stacks one keyboard per inversion (persisted per user). */
export function useShowInversions() {
  return useDraft(inversionsStore, false);
}
