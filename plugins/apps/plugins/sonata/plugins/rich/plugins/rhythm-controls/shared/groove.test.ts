import { describe, expect, test } from "bun:test";

import {
  patternFromPreset,
  rotate,
  toggleOnset,
  type RhythmPattern,
} from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import {
  DEFAULT_BASS_VOICING,
  DEFAULT_CHORD_VOICING,
  findFiguration,
} from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import {
  grooveEquals,
  grooveSummary,
  presetGroove,
  type GrooveFields,
} from "./groove";
import { groovePresetsConfig } from "./groove-presets";

const base: GrooveFields = {
  presetId: null,
  bass: patternFromPreset("basic-2"),
  chord: patternFromPreset("son"),
  bassFigurationId: "root",
  chordFigurationId: "block",
  bassVoicing: DEFAULT_BASS_VOICING,
  chordVoicing: DEFAULT_CHORD_VOICING,
};

describe("grooveEquals", () => {
  test("a groove equals itself", () => {
    expect(grooveEquals(base, base)).toBe(true);
  });

  test("ignores the groove's and each pattern's provenance", () => {
    const other: GrooveFields = {
      ...base,
      presetId: "son-clave",
      chord: { ...base.chord, presetId: null },
    };
    expect(grooveEquals(base, other)).toBe(true);
  });

  test("ignores how a rotation is represented", () => {
    const rotated = rotate(base.chord, 2);
    // The same struck pulses, spelt as pre-rotated onsets with rotation 0.
    const baked: RhythmPattern = {
      presetId: null,
      subdivisions: 16,
      onsets: [2, 5, 8, 12, 14],
      rotation: 0,
    };
    expect(
      grooveEquals({ ...base, chord: rotated }, { ...base, chord: baked }),
    ).toBe(true);
  });

  test("a rotation that moves the struck pulses differs", () => {
    expect(grooveEquals(base, { ...base, chord: rotate(base.chord, 1) })).toBe(
      false,
    );
  });

  test("a toggled bead differs", () => {
    expect(
      grooveEquals(base, { ...base, bass: toggleOnset(base.bass, 2) }),
    ).toBe(false);
  });

  test("a different subdivision count differs, even with the same onsets", () => {
    const wider: RhythmPattern = { ...base.bass, subdivisions: 16 };
    expect(grooveEquals(base, { ...base, bass: wider })).toBe(false);
  });

  test("a different figuration on either hand differs", () => {
    expect(
      grooveEquals(base, { ...base, bassFigurationId: "root-fifth" }),
    ).toBe(false);
    expect(
      grooveEquals(base, { ...base, chordFigurationId: "arpeggio-up" }),
    ).toBe(false);
  });
});

describe("grooveEquals — voicing", () => {
  test("a different octave, voice-leading, doubling or on/off differs", () => {
    for (const change of [
      { octave: 3 },
      { voiceLead: true },
      { doubleOctave: true },
      { enabled: false },
    ]) {
      expect(
        grooveEquals(base, {
          ...base,
          bassVoicing: { ...base.bassVoicing, ...change },
        }),
      ).toBe(false);
    }
  });
});

describe("grooveSummary", () => {
  test("a hand that is off reads as a dash", () => {
    expect(
      grooveSummary({
        ...base,
        bassVoicing: { ...base.bassVoicing, enabled: false },
      }),
    ).toBe("Block · —");
  });

  test("names the right hand, then the left, by figuration label", () => {
    expect(grooveSummary({ ...base, bassFigurationId: "root-fifth" })).toBe(
      "Block · Root–fifth",
    );
  });

  test("throws on an unknown figuration", () => {
    expect(() =>
      grooveSummary({ ...base, bassFigurationId: "nope" }),
    ).toThrow();
  });
});

describe("presetGroove", () => {
  test("carries the preset's content and records it as provenance", () => {
    const preset = groovePresetsConfig.defaults.presets.find(
      (p) => p.id === "son-clave",
    );
    if (!preset) throw new Error("seed son-clave missing");
    const groove = presetGroove(preset);
    expect(groove.presetId).toBe("son-clave");
    expect(grooveEquals(groove, preset)).toBe(true);
  });
});

describe("seed presets", () => {
  const presets = groovePresetsConfig.defaults.presets;

  test("every seed has a unique explicit id", () => {
    const ids = presets.map((p) => p.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(
      true,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every seed names real figurations", () => {
    // findFiguration throws on an id no figuration carries.
    for (const p of presets) {
      expect(findFiguration(p.bassFigurationId).id).toBe(p.bassFigurationId);
      expect(findFiguration(p.chordFigurationId).id).toBe(p.chordFigurationId);
    }
  });

  test("every seed parses against the config schema", () => {
    expect(() => groovePresetsConfig.schema.parse({ presets })).not.toThrow();
  });
});
