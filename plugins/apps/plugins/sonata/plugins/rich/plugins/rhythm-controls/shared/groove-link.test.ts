import { describe, expect, it } from "bun:test";
import { decodeGrooveLink, encodeGrooveLink } from "./groove-link";
import type { GrooveFields } from "./groove";

/** The stride seed as a song plays it. */
const stride: GrooveFields = {
  presetId: "stride",
  restartOnChordChange: true,
  chord: { presetId: "basic-2", subdivisions: 8, onsets: [0, 4], rotation: 0 },
  chordFigurationId: "block",
  chordVoicing: {
    enabled: true,
    octave: 4,
    voiceLead: true,
    doubleOctave: false,
  },
  bass: {
    presetId: "basic-4",
    subdivisions: 16,
    onsets: [0, 4, 8, 12],
    rotation: 0,
  },
  bassFigurationId: "stride",
  bassVoicing: {
    enabled: true,
    octave: 2,
    voiceLead: false,
    doubleOctave: false,
  },
};

/** Every field off its default: a custom rhythm, turned, a silent hand. */
const custom: GrooveFields = {
  presetId: null,
  restartOnChordChange: false,
  chord: {
    presetId: "son",
    subdivisions: 16,
    onsets: [0, 3, 6, 10, 12],
    rotation: 2,
  },
  chordFigurationId: "harp-roll",
  chordVoicing: {
    enabled: true,
    octave: 5,
    voiceLead: false,
    doubleOctave: true,
  },
  bass: { presetId: null, subdivisions: 8, onsets: [0, 3, 5], rotation: 0 },
  bassFigurationId: "root-fifth",
  bassVoicing: {
    enabled: false,
    octave: 2,
    voiceLead: false,
    doubleOctave: false,
  },
};

describe("groove link", () => {
  it("spells a seed groove in words", () => {
    expect(encodeGrooveLink(stride)).toBe(
      "stride~R.block.basic-2~L.stride.basic-4",
    );
  });

  it("spells what differs from the defaults, and a custom rhythm as beads", () => {
    expect(encodeGrooveLink(custom)).toBe(
      "R.harp-roll.o5.novl.dbl.r2.son~L.root-fifth.off.x--x-x--~norestart",
    );
  });

  it("round-trips", () => {
    for (const g of [stride, custom]) {
      expect(decodeGrooveLink(encodeGrooveLink(g))).toEqual({
        ok: true,
        groove: g,
      });
    }
  });

  it("leaves the URL unescaped", () => {
    const value = encodeGrooveLink(custom);
    expect(encodeURIComponent(value)).toBe(value);
  });

  it("refuses a value that is not a groove", () => {
    for (const bad of [
      "",
      "R.block.basic-2",
      "L.root.basic-2~R.block.basic-2",
      "R.block.nope~L.root.basic-2",
      "R.block.o9.basic-2~L.root.basic-2",
      "R.block.loud.basic-2~L.root.basic-2",
      "R.root.basic-2~L.root.basic-2",
      "a b~R.block.basic-2~L.root.basic-2",
    ]) {
      expect(decodeGrooveLink(bad).ok).toBe(false);
    }
  });
});
