import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";

/**
 * The chord colours: one per Roman numeral's number, the root read against
 * its tonic on the major scale in every key (`music/chord-box`'s rootReading) —
 * `chord-1` … `chord-7` are I … VII, an accidental keeping its number's colour
 * (♭VII is VII's, ♭III III's) — and `chord-outside`, the neutral for a chord
 * with no key.
 *
 * The most common chords sit on the most distant hues — I orange, IV sage,
 * V blue, vi violet — then ii gold, iii rose, vii teal; a chord with no key is a
 * neutral grey. No `darkDefault`: the chord box deepens the colour toward black for
 * its tile on either ground (`music/chord-box`), so the hue itself does not
 * change with the page.
 */
export const chordPaletteGroup = defineTokenGroup("chord-palette", {
  "chord-1": { default: "#EC8A3A", label: "I" },
  "chord-2": { default: "#E2B23A", label: "II" },
  "chord-3": { default: "#DE6A9A", label: "III" },
  "chord-4": { default: "#7FB685", label: "IV" },
  "chord-5": { default: "#3AA4D0", label: "V" },
  "chord-6": { default: "#9C6FE6", label: "VI" },
  "chord-7": { default: "#2FB5A8", label: "VII" },
  "chord-outside": { default: "#8C8A85", label: "No key" },
});

export type ChordPaletteValues = {
  [K in keyof typeof chordPaletteGroup.schema]: string;
};
