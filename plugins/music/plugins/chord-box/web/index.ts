import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { ChordBox } from "./components/chord-box";
export type {
  ChordBoxHit,
  ChordBoxLabel,
  ChordBoxProps,
} from "./components/chord-box";
export { ChordNumeral } from "./components/chord-numeral";
export { chordColour, chordToneStyle } from "./chord-tone";
export { chordPaint } from "./chord-paint";
export type { ChordPaint } from "./chord-paint";

export default {
  description:
    "The chord box: <ChordBox> (a frame painted in the colour of its numeral's number — filled tile, given or empty — holding its numeral and name, with a full-bleed hit button behind the content and now / selected states), <ChordNumeral> (the Roman numeral in the display serif, its mark raised in the sans), chordToneStyle / chordColour (the degree's --chord-N colour and tile depth as the --fn custom properties the .chord-tone paint reads), and chordPaint — the four named paints (tile, tint, tint-quiet, ghost) every chord surface applies by name instead of re-stating a chord colour, with .chord-caption for a reading under a numeral (V/V, I/3) in the paint's own ink. Knows degrees and strings only, so any app can draw a chord the same way.",
  contributions: [],
} satisfies PluginDefinition;
