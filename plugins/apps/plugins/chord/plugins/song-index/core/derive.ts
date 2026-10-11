import {
  hookpadChordSound,
  hookpadKeyAt,
  hookpadTonicPc,
  type HookpadChord,
  type HookpadChordRule,
  type HookpadKey,
  type HookpadMeter,
  type HookpadTempo,
} from "@plugins/integrations/plugins/hooktheory/core";
import type { Alignment } from "./beat-time";
import { chordFeatures } from "./features";
import type { IndexedChord } from "./indexed-chord";
import { LOOP_SHAPE_IDS, LOOP_SHAPES, type LoopWindow } from "./loop-shapes";
import { chordToken } from "./token";

/**
 * The version of everything derived from a section: the chord converter, the
 * token format, the feature list, `LOOP_SHAPES`, and the skip rules below.
 * Bump it with any change to one of them; an index loaded at an older version
 * is reloaded from the snapshot.
 */
export const INDEX_DERIVATION_VERSION = 3;

/** What derivation reads of a section, from whichever source (the dump snapshot, the live API). */
export type DeriveSectionInput = {
  chords: readonly HookpadChord[];
  keys: readonly HookpadKey[];
  meters: readonly HookpadMeter[];
  tempos: readonly HookpadTempo[];
  /** Hookpad's `endBeat`: the section ends there (exclusive). */
  endBeat: number;
  /** The playable YouTube video id (`youtubeVideoId`), or `null` when none was pasted or it is not a YouTube id. */
  videoId: string | null;
  alignment: Alignment;
};

/**
 * Why a whole section is left out of the index. Sheet Sage's rules, so the
 * index holds exactly the sections Sheet Sage could read:
 *
 * - `unreadable:<rule>` — a chord (rests included) breaks a rule of
 *   `hookpadChordSound`; the reference drops the whole section.
 * - `chord-before-first-key` — a chord's beat comes before every key, so it
 *   has no key to be read in. Never seen in the dump.
 * - `no-chords` — nothing sounds (empty harmony, or only rests).
 * - `chord-past-end` — a sounding chord ends after `endBeat` (Sheet Sage's
 *   lead-sheet rule; 6 dump sections).
 *
 * A document the section schema refuses never gets here: the snapshot builder
 * records that one itself.
 */
export type SectionSkipReason =
  | `unreadable:${HookpadChordRule}`
  | "chord-before-first-key"
  | "no-chords"
  | "chord-past-end";

/**
 * Why an indexed section has no loops at all. Kept in the index (its chords
 * are real data) but the trainer can never play it.
 */
export type SectionUnloopableReason = "no-video" | "no-timing";

export type SectionLoops =
  /** Every loop shape's windows. May be empty (a section shorter than 4 bars, a key change every 2 bars). */
  | { kind: "windows"; windows: LoopWindow[] }
  | { kind: "unloopable"; reason: SectionUnloopableReason };

export type DerivedSection =
  | { kind: "indexed"; chords: IndexedChord[]; loops: SectionLoops }
  | { kind: "skipped"; reason: SectionSkipReason; detail: string };

/** Sheet Sage's tolerance on "a chord ends after endBeat". */
const END_EPS = 1e-6;

/**
 * Read a section into the index: each chord's token and features, and its
 * loop windows — or the rule that leaves it out. Pure: the same input and
 * `INDEX_DERIVATION_VERSION` always give the same result.
 */
export function deriveSection(section: DeriveSectionInput): DerivedSection {
  const chords: IndexedChord[] = [];
  for (const chord of section.chords) {
    const keyAt = hookpadKeyAt(section.keys, chord.beat);
    if (keyAt.kind === "before-first-key") {
      return {
        kind: "skipped",
        reason: "chord-before-first-key",
        detail: `a chord at beat ${chord.beat} comes before every key`,
      };
    }
    const reading = hookpadChordSound(chord, keyAt.key);
    if (reading.kind === "unreadable") {
      return {
        kind: "skipped",
        reason: `unreadable:${reading.rule}`,
        detail: `chord at beat ${chord.beat}: ${reading.detail}`,
      };
    }
    chords.push({
      chord,
      key: keyAt.key,
      reading:
        reading.kind === "rest"
          ? { kind: "rest" }
          : {
              kind: "sound",
              token: chordToken(reading.sound, hookpadTonicPc(keyAt.key.tonic)),
              features: chordFeatures(chord),
            },
    });
  }

  const sounding = chords.filter((c) => c.reading.kind === "sound");
  if (sounding.length === 0) {
    return {
      kind: "skipped",
      reason: "no-chords",
      detail: `${section.chords.length} chords, none sounding`,
    };
  }
  const overrun = sounding.find(
    (c) => c.chord.beat + c.chord.duration > section.endBeat + END_EPS,
  );
  if (overrun !== undefined) {
    return {
      kind: "skipped",
      reason: "chord-past-end",
      detail: `a chord at beat ${overrun.chord.beat} lasting ${overrun.chord.duration} ends after endBeat ${section.endBeat}`,
    };
  }

  return { kind: "indexed", chords, loops: sectionLoops(section, chords) };
}

function sectionLoops(
  section: DeriveSectionInput,
  chords: readonly IndexedChord[],
): SectionLoops {
  if (section.videoId === null)
    return { kind: "unloopable", reason: "no-video" };
  if (section.alignment.kind === "none") {
    return { kind: "unloopable", reason: "no-timing" };
  }
  const input = {
    chords,
    keys: section.keys,
    meters: section.meters,
    tempos: section.tempos,
    endBeat: section.endBeat,
  };
  return {
    kind: "windows",
    windows: LOOP_SHAPE_IDS.flatMap((id) => LOOP_SHAPES[id].enumerate(input)),
  };
}
