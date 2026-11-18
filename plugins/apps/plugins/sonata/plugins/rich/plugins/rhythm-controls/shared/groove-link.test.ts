import { describe, expect, it } from "bun:test";
import { decodeGrooveLink, encodeGrooveLink } from "./groove-link";
import type { GrooveFields } from "./groove";

const groove: GrooveFields = {
  presetId: "bossa-nova",
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
    octave: 4,
    voiceLead: true,
    doubleOctave: false,
  },
  bass: { presetId: null, subdivisions: 8, onsets: [0, 4], rotation: 0 },
  bassFigurationId: "root-fifth",
  bassVoicing: {
    enabled: false,
    octave: 2,
    voiceLead: false,
    doubleOctave: true,
  },
};

describe("groove link", () => {
  it("round-trips every field", () => {
    const value = encodeGrooveLink(groove);
    expect(value).toMatch(/^1\.[A-Za-z0-9_-]+$/);
    expect(decodeGrooveLink(value)).toEqual({ ok: true, groove });
  });

  it("round-trips a null preset", () => {
    const g = { ...groove, presetId: null };
    expect(decodeGrooveLink(encodeGrooveLink(g))).toEqual({
      ok: true,
      groove: g,
    });
  });

  it("refuses an unknown version", () => {
    const value = encodeGrooveLink(groove).replace(/^1\./, "9.");
    expect(decodeGrooveLink(value).ok).toBe(false);
  });

  it("refuses text that is not base64url", () => {
    expect(decodeGrooveLink("1.%%%").ok).toBe(false);
    expect(decodeGrooveLink("1.a").ok).toBe(false);
  });

  it("refuses a valid encoding of the wrong shape", () => {
    const value = `1.${btoa(JSON.stringify({ a: 1 })).replace(/=+$/, "")}`;
    expect(decodeGrooveLink(value).ok).toBe(false);
  });

  it("refuses an onset outside its subdivisions", () => {
    const bad = {
      ...groove,
      bass: { ...groove.bass, onsets: [0, 9] },
    };
    expect(decodeGrooveLink(encodeGrooveLink(bad)).ok).toBe(false);
  });

  it("refuses a figuration its hand does not offer", () => {
    const bad = { ...groove, bassFigurationId: "block" };
    expect(decodeGrooveLink(encodeGrooveLink(bad)).ok).toBe(false);
  });
});
