import { useMemo } from "react";
import {
  useCursorSelector,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import {
  songKey,
  type ChordAnnotation,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { chordVoicing } from "@plugins/apps/plugins/sonata/plugins/theory/core";
import {
  chordBoxFace,
  useChordDisplayMode,
  type ChordBoxFace,
} from "@plugins/apps/plugins/sonata/plugins/rich/plugins/chord-label/web";
import {
  ChordKeyboardRow,
  useReadoutPlane,
} from "@plugins/apps/plugins/sonata/plugins/rich/plugins/readout-keyboard/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";

/** One distinct chord of the song. */
interface ChordEntry {
  /** Its spelled name plus root: two occurrences with the same key are the same chord. */
  key: string;
  /** Its first occurrence, which names, paints and voices it and is where a click seeks. */
  first: ChordAnnotation;
  face: ChordBoxFace;
  /** Its notes, root position with a slash bass lowest — before the readout window's octave fit. */
  voicing: number[];
  /** How many times it is struck. */
  uses: number;
}

/** No notes — a stable identity for a row the fit left empty. */
const NO_NOTES: readonly number[] = [];

const entryKey = (c: ChordAnnotation) =>
  `${c.data.spelledSymbol ?? c.data.symbol}|${String(c.data.root)}`;

/**
 * Every distinct chord in order of first appearance, with how often it is
 * played — each numbered and coloured in the song's home key (`songKey`): the
 * list spans the whole song, so it has one key, not the key wherever a chord
 * happens to appear first.
 */
function distinctChords(
  score: Score,
  mode: ReturnType<typeof useChordDisplayMode>,
): ChordEntry[] {
  const home = songKey(score)?.key ?? null;
  const byKey = new Map<string, ChordEntry>();
  const chords = score.annotations
    .filter((a): a is ChordAnnotation => a.type === "chord")
    .sort((a, b) => a.start - b.start);
  for (const c of chords) {
    const key = entryKey(c);
    const known = byKey.get(key);
    if (known) {
      known.uses++;
      continue;
    }
    const face = chordBoxFace(c.data, home, mode);
    byKey.set(key, {
      key,
      first: c,
      face,
      voicing: chordVoicing(c.data),
      uses: 1,
    });
  }
  return [...byKey.values()];
}

/**
 * The song's chord vocabulary — the BODY of a `Sonata.Section` card whose
 * chrome (Card + collapsible "Chord list" title) the host paints. One row per
 * distinct chord, in the order the song first plays them: its chord box (in
 * the song's home key), a keyboard lit with its notes in its colour, and how
 * many times it is played.
 * The chord under the playhead is marked; clicking a row sounds the chord (the
 * notes its keyboard lights) and seeks to its first occurrence.
 *
 * Applicability is the contribution's `useAvailable` (`useHasChords`), so this
 * body never renders for a chordless song.
 *
 * Not a DataView: the rows are derived from the open score, not stored records,
 * their order (first appearance) is the content itself rather than a sort, and
 * the row's body is a keyboard, which no DataView field renders.
 */
export function ChordList() {
  const { score, seekTo } = useSession();
  const mode = useChordDisplayMode();

  const entries = useMemo(() => distinctChords(score, mode), [score, mode]);

  // One plane for every row — the rows differ only in what is lit — fitted
  // to every chord's voicing at once.
  const voicings = useMemo(() => entries.map((e) => e.voicing), [entries]);
  const { plane, voicings: fitted } = useReadoutPlane(voicings);

  // The key of the chord under the playhead; reconciles only on a chord boundary.
  const nowKey = useCursorSelector(
    (beat) => {
      const c = score.annotations.find(
        (a): a is ChordAnnotation =>
          a.type === "chord" && beat >= a.start && beat < a.end,
      );
      return c === undefined ? undefined : entryKey(c);
    },
    [score.annotations],
  );

  return (
    <Stack gap="2xs">
      {entries.map((entry, i) => (
        <ChordKeyboardRow
          key={entry.key}
          degree={entry.face.degree}
          label={entry.face.label}
          name={`${entry.face.name}, played ${String(entry.uses)} times`}
          plane={plane}
          notes={fitted[i] ?? NO_NOTES}
          now={entry.key === nowKey}
          trail={`×${String(entry.uses)}`}
          description="go to its first time"
          onPick={() => seekTo(entry.first.start)}
        />
      ))}
    </Stack>
  );
}
