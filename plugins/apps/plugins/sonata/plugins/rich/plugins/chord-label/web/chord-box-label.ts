import type {
  ChordData,
  KeySignature,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  romanNumeralParts,
  tonicPc,
  type ChordDisplayMode,
} from "@plugins/apps/plugins/sonata/plugins/theory/core";
import type { ChordBoxLabel } from "@plugins/music/plugins/chord-box/web";
import {
  scaleDegree,
  type ScaleDegree,
} from "@plugins/music/plugins/chord-box/core";

/** A chord symbol's head (the root letter and accidental) and the rest of it. */
const SYMBOL_HEAD = /^([A-G](?:[#b♯♭]{1,2})?)(.*)$/;

/** How a chord is drawn as a chord box: its paint and its text. */
export interface ChordBoxFace {
  /** The root's degree in the key's own scale, which paints the box; `null` (no key, or a root outside the scale) paints grey. */
  degree: ScaleDegree | null;
  label: ChordBoxLabel;
  /** The chord's name as written, for an accessible label. */
  name: string;
}

/**
 * How `chord` is drawn as a chord box under the chord-label `mode`, in `key`
 * (the key in force at its onset; `null` for a keyless score). The colour is
 * the root's degree in the key's own scale — the natural minor for a minor
 * key, so its III, VI and VII are coloured and the tonic always wears the
 * first colour. The text follows the mode the way `formatChordLabel` does — `roman`
 * the numeral, `both` the numeral over the name, `symbol` the name — and falls
 * back to the name when there is no numeral (no key, or a quality outside the
 * vocabulary), so a box is never blank. The name is the key's spelling of the chord when it has one.
 */
export function chordBoxFace(
  chord: ChordData,
  key: KeySignature | null,
  mode: ChordDisplayMode,
): ChordBoxFace {
  const name = chord.spelledSymbol ?? chord.symbol;
  const degree =
    key === null ? null : scaleDegree(chord.root, tonicPc(key.tonic), key.mode);
  const parts = key === null ? null : romanNumeralParts(chord, key);
  if (mode === "symbol" || parts === null) {
    const m = SYMBOL_HEAD.exec(name);
    return {
      degree,
      name,
      label:
        m === null
          ? { primary: "name", name }
          : { primary: "name", name: m[1]!, mark: m[2]! },
    };
  }
  return {
    degree,
    name,
    label: {
      primary: "numeral",
      numeral: parts.numeral,
      mark: parts.mark,
      ...(mode === "both" ? { name } : {}),
    },
  };
}
