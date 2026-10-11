import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  useReadoutPlane,
  ReadoutKeyboard,
  KeyboardCaption,
} from "./components/readout-keyboard";
export type { ReadoutPlane } from "./components/readout-keyboard";
export {
  ChordKeyboardRow,
  ChordRowFrame,
} from "./components/chord-keyboard-row";

// No contributions: a building block the rich sections (current chord, chord
// list, current key) compose, so every readout keyboard (and chord row) has one shape — the
// two-octave window, proportional keys, Sonata's skin, the same caption row.
export default {
  description:
    "Sonata readout keyboard: useReadoutPlane (voicings octave-fitted into the two-octave readout window, laid in the active pitch layout), ReadoutKeyboard (proportional keys in Sonata's skin), KeyboardCaption (lead · trail caption row, trail accented when current) and ChordKeyboardRow (a chord's box, its keyboard lit in its colour and a trail — the whole row a button that sounds the chord — shared by the chord list and the current key's chords) with ChordRowFrame, its lead · keyboard · trail columns for a keyboard that must line up with the rows.",
  contributions: [],
} satisfies PluginDefinition;
