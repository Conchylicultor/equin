import { describe, expect, test } from "bun:test";
import { fromLinkText, toLinkText } from "./link-text";

describe("link text", () => {
  test("spells spaces, newlines and comments readably", () => {
    expect(toLinkText("key: Eb\n\n; Intro\n(Abmaj7 Gm7) .")).toBe(
      "key:_Eb~~!_Intro~(Abmaj7_Gm7)_.",
    );
    expect(encodeURIComponent(toLinkText("New Chord Grid"))).toBe(
      "New_Chord_Grid",
    );
  });

  test("round-trips text holding the spelling's own characters", () => {
    for (const text of [
      "a_b ~c! *d* ;e",
      "F#m7b5 C/E (G7(#5) C)",
      "***__~~!!",
      "",
    ]) {
      expect(fromLinkText(toLinkText(text))).toBe(text);
    }
  });

  test("reads a plain-text value as itself", () => {
    expect(fromLinkText("New Chord Grid")).toBe("New Chord Grid");
  });
});
