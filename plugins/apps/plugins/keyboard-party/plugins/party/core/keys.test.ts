import { describe, expect, test } from "bun:test";
import { beadLabel, classifyKey, LETTER_WORDS, pentatonicHz } from "./keys";

describe("classifyKey", () => {
  test("letters are case-insensitive and indexed from A", () => {
    expect(classifyKey("a")).toEqual({ kind: "letter", letter: "A", index: 0 });
    expect(classifyKey("Z")).toEqual({
      kind: "letter",
      letter: "Z",
      index: 25,
    });
  });

  test("every letter has a picture and a word", () => {
    for (let i = 0; i < 26; i++) {
      expect(LETTER_WORDS[String.fromCharCode(65 + i)]).toBeDefined();
    }
  });

  test("named keys map to their effect", () => {
    expect(classifyKey("7")).toEqual({ kind: "digit", digit: 7 });
    expect(classifyKey(" ").kind).toBe("fireworks");
    expect(classifyKey("Enter").kind).toBe("rainbow");
    expect(classifyKey("ArrowLeft")).toEqual({
      kind: "flier",
      direction: "left",
    });
    expect(classifyKey("Backspace").kind).toBe("sweep");
    expect(classifyKey("Escape").kind).toBe("sweep");
    expect(classifyKey("Shift")).toEqual({ kind: "boing", modifier: "Shift" });
  });

  test("other keys get confetti seeded by the key, stable per key", () => {
    const a = classifyKey("F5", "F5");
    const b = classifyKey("PageDown", "PageDown");
    expect(a.kind).toBe("confetti");
    expect(a).toEqual(classifyKey("F5", "F5"));
    expect(a).not.toEqual(b);
    // a non-printable key name leaves no bead; a printable one does
    expect(beadLabel(a)).toBeNull();
    expect(beadLabel(classifyKey("?"))).toBe("?");
  });
});

test("pentatonicHz climbs an octave every five steps", () => {
  expect(pentatonicHz(0)).toBeCloseTo(261.63, 1);
  expect(pentatonicHz(5)).toBeCloseTo(523.26, 1);
  expect(pentatonicHz(1)).toBeGreaterThan(pentatonicHz(0));
});
