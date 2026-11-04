import { describe, expect, it } from "bun:test";
import { compile } from "./compile";

/** The `type:"key"` annotations a compiled grid carries. */
const keyAnnotations = (text: string) =>
  compile({ text }).annotations.filter((a) => a.type === "key");

describe("compile — authored key context", () => {
  it("carries a starting key directive as meta.key", () => {
    const score = compile({ text: "key: Eb\nI IV" });
    expect(score.meta.key).toEqual({ tonic: "Eb", mode: "major" });
    expect(keyAnnotations("key: Eb\nI IV")).toEqual([]);
  });

  it("declares no key when the grid has no directive", () => {
    expect(compile({ text: "C G Am F" }).meta.key).toBeUndefined();
  });

  it("emits a mid-grid modulation as a key annotation spanning to the end", () => {
    const score = compile({ text: "I V\nkey: D\nI V" });
    expect(score.meta.key).toBeUndefined();
    expect(score.annotations.filter((a) => a.type === "key")).toEqual([
      {
        type: "key",
        start: 8,
        end: 16,
        data: { tonic: "D", mode: "major" },
        source: "authored",
      },
    ]);
  });

  it("bounds each modulation by the next one", () => {
    const keys = keyAnnotations("key: C\nI\nkey: G\nI\nkey: D\nI");
    expect(keys.map((a) => [a.start, a.end])).toEqual([
      [4, 8],
      [8, 12],
    ]);
  });

  it("compiles Roman numerals into authored chord annotations", () => {
    const chords = compile({ text: "key: A\nI vi IV V" }).annotations.filter(
      (a) => a.type === "chord",
    );
    expect(chords.map((a) => (a.data as { symbol: string }).symbol)).toEqual([
      "A",
      "F#m",
      "D",
      "E",
    ]);
    expect(chords.every((a) => a.source === "authored")).toBe(true);
  });
});
