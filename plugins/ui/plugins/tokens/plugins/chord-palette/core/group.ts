import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";

/**
 * The chord colours: one per scale degree a chord's root sits on,
 * relative to the tonic and read in the key's own scale — `chord-1` … `chord-7`
 * are I, ii, iii, IV, V, vi, vii° in a major key and i, ii°, III, iv, v, VI,
 * VII in a minor one (natural minor), so the tonic is always `chord-1` — and
 * `chord-outside` for a root outside the scale (♭VII in major, ♯IV, …).
 *
 * The most common chords sit on the most distant hues — I orange, IV sage,
 * V blue, vi violet — then ii gold, iii rose, vii teal; outside is a neutral
 * grey. No `darkDefault`: the chord box deepens the colour toward black for
 * its tile on either ground (`music/chord-box`), so the hue itself does not
 * change with the page.
 */
export const chordPaletteGroup = defineTokenGroup("chord-palette", {
  "chord-1": { default: "#EC8A3A", label: "1 (I · i)" },
  "chord-2": { default: "#E2B23A", label: "2 (ii · ii°)" },
  "chord-3": { default: "#DE6A9A", label: "3 (iii · III)" },
  "chord-4": { default: "#7FB685", label: "4 (IV · iv)" },
  "chord-5": { default: "#3AA4D0", label: "5 (V · v)" },
  "chord-6": { default: "#9C6FE6", label: "6 (vi · VI)" },
  "chord-7": { default: "#2FB5A8", label: "7 (vii° · VII)" },
  "chord-outside": { default: "#8C8A85", label: "Outside the scale" },
});

export type ChordPaletteValues = {
  [K in keyof typeof chordPaletteGroup.schema]: string;
};
