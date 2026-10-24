import { describe, expect, test } from "bun:test";
import { parseIconAnswer } from "./parse-icon-answer";

const none = new Set<string>();

// The picked emoji as a plain string, or the failure — what every case asserts on.
function pick(out: string, avoid: ReadonlySet<string>): string | undefined {
  const r = parseIconAnswer(out, avoid);
  return r.ok ? r.emoji : undefined;
}

describe("parseIconAnswer", () => {
  test("takes EMOJI", () => {
    expect(pick("EMOJI: 🧪\nALT: 🔬", none)).toBe("🧪");
  });

  test("tolerates spacing, case and surrounding chatter lines", () => {
    expect(pick("Sure.\n  emoji:🎶  \nalt : 🎸\n", none)).toBe("🎶");
  });

  test("falls back to ALT when a sibling has EMOJI", () => {
    expect(pick("EMOJI: 🗺️\nALT: 🧭", new Set(["🗺️"]))).toBe("🧭");
  });

  test("keeps EMOJI when a sibling has both", () => {
    expect(pick("EMOJI: 🎸\nALT: 🎵", new Set(["🎸", "🎵"]))).toBe("🎸");
  });

  test("an invalid EMOJI line falls back to ALT", () => {
    expect(pick("EMOJI: rocket\nALT: 🚀", none)).toBe("🚀");
    expect(pick("EMOJI: 🚀🚀\nALT: 🛰️", none)).toBe("🛰️");
  });

  test("restores a dropped variation selector", () => {
    expect(pick("EMOJI: \u{1F5FA}\nALT: 🧭", none)).toBe("\u{1F5FA}\uFE0F");
  });

  test("accepts ZWJ sequences, skin tones and flags", () => {
    for (const e of ["👩‍💻", "👍🏽", "🇯🇵", "#️⃣"]) {
      expect(pick(`EMOJI: ${e}\nALT: 🧪`, none)).toBe(e);
    }
  });

  test("junk is unusable", () => {
    const r = parseIconAnswer("I need more context about this page.", none);
    expect(r.ok).toBe(false);
    expect(parseIconAnswer("EMOJI: ab\nALT: page", none).ok).toBe(false);
    expect(parseIconAnswer("", none).ok).toBe(false);
  });
});
