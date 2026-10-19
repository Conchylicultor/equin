import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { LyricLineText } from "./components/lyric-line-text";
export type {
  LyricChordStyle,
  LyricLineTextProps,
} from "./components/lyric-line-text";

export default {
  description:
    "One songsheet line as text: <LyricLineText> — the chord row (each chord pinned over its lyric column) stacked over the words, monospace so a column is one character — or, as `layout: words`, the line's words flowing in the surface's own font, each chord over the word it starts on — with no chrome of its own and an optional chordStyle so the caller paints the chords. Shared by the Songsheet and the Chord grid's lyrics.",
  contributions: [],
} satisfies PluginDefinition;
