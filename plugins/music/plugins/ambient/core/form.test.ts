import { describe, expect, test } from "bun:test";
import {
  SECTION_KINDS,
  answerOf,
  createComposer,
  makeMotif,
  varyMotif,
  type FormSpec,
} from "./form";
import { mulberry32 } from "@plugins/packages/plugins/seeded-random/core";

const SPEC: FormSpec<string> = {
  progressions: {
    intro: [["I", "vi"]],
    verse: [
      ["I", "V", "vi", "IV"],
      ["ii", "V", "I", "vi"],
    ],
    chorus: [["IV", "V", "iii", "vi"]],
    bridge: [["bVII", "IV", "bVI", "V"]],
    break: [["IV", "I"]],
  },
  bars: {
    intro: [2, 4],
    verse: [8, 16],
    chorus: [8, 8],
    bridge: [4, 8],
    break: [4, 4],
  },
  keys: [0, 2, -2, 3],
  scaleSteps: 8,
};

const plans = (seed: number, n: number) => {
  const c = createComposer(SPEC, seed);
  return Array.from({ length: n }, (_, i) => c.barAt(i));
};

describe("createComposer", () => {
  test("the same seed writes the same form", () => {
    const a = plans(7, 200).map((p) => [p.kind, p.chord, p.shift, p.motif]);
    const b = plans(7, 200).map((p) => [p.kind, p.chord, p.shift, p.motif]);
    expect(a).toEqual(b);
  });

  test("different seeds write different forms", () => {
    const a = plans(1, 200).map((p) => `${p.kind}${p.chord}${p.shift}`);
    const b = plans(2, 200).map((p) => `${p.kind}${p.chord}${p.shift}`);
    expect(a).not.toEqual(b);
  });

  test("it opens on an intro, then plays every kind of section and moves key", () => {
    const ps = plans(3, 2000);
    expect(ps[0]!.kind).toBe("intro");
    expect(new Set(ps.map((p) => p.kind))).toEqual(new Set(SECTION_KINDS));
    expect(new Set(ps.map((p) => p.shift)).size).toBeGreaterThan(1);
  });

  test("the music does not loop: no 32-bar window repeats in the first 2000 bars", () => {
    const ps = plans(5, 2000);
    const sig = (i: number) =>
      ps
        .slice(i, i + 32)
        .map((p) => `${p.chord}${p.shift}${JSON.stringify(p.motif)}`)
        .join("|");
    const seen = new Set<string>();
    for (let i = 0; i + 32 <= ps.length; i += 4) {
      const s = sig(i);
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
  });

  test("sections are whole progressions, marked by entry and fill", () => {
    const ps = plans(11, 500);
    for (const p of ps) {
      expect(p.entry).toBe(p.barInSection === 0);
      expect(p.fill).toBe(p.barInSection === p.sectionBars - 1);
    }
    for (let i = 0; i + 1 < ps.length; i++)
      if (!ps[i]!.fill) expect(ps[i]!.nextChord).toBe(ps[i + 1]!.chord);
      else expect(ps[i + 1]!.entry).toBe(true);
  });

  test("a skipped stretch is fine, a passed section is refused", () => {
    const c = createComposer(SPEC, 9);
    c.barAt(0);
    const far = c.barAt(400);
    expect(far.barInSection).toBeGreaterThanOrEqual(0);
    expect(() => c.barAt(0)).toThrow(/already passed/);
  });

  test("a palette without the written key is refused", () => {
    expect(() => createComposer({ ...SPEC, keys: [2, 3] }, 1)).toThrow(
      /written key/,
    );
  });
});

describe("motifs", () => {
  test("stay inside the scale, in the bar", () => {
    const rand = mulberry32(4);
    for (let k = 0; k < 200; k++) {
      const m = makeMotif(rand, 6, 0.6);
      for (const x of [m, answerOf(m, 6, rand), varyMotif(m, 6, rand)])
        for (const n of x.notes) {
          expect(n.step).toBeGreaterThanOrEqual(0);
          expect(n.step).toBeLessThan(6);
          expect(n.at).toBeGreaterThanOrEqual(0);
          expect(n.at).toBeLessThan(1);
          expect(n.len).toBeGreaterThan(0);
        }
    }
  });

  test("the answer keeps the motif's rhythm", () => {
    const rand = mulberry32(8);
    const m = makeMotif(rand, 8, 0.6);
    expect(answerOf(m, 8, rand).notes.map((n) => n.at)).toEqual(
      m.notes.map((n) => n.at),
    );
  });
});
