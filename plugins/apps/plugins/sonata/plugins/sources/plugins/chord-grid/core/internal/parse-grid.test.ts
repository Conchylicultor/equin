import { describe, expect, it } from "bun:test";
import { parseGrid } from "./parse-grid";

/** Symbols of the parsed chord events, in order. */
const symbols = (text: string) =>
  parseGrid(text).events.map((e) => e.data.symbol);

describe("parseGrid — parenthetical alterations", () => {
  it("keeps a chord's attached (…) as one token, not a group", () => {
    const { events, skipped } = parseGrid("G7(♯5)");
    expect(skipped).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]!.data.symbol).toBe("G7(♯5)");
  });

  it("parses the three previously-unrecognised chords in one grid", () => {
    const { events, skipped } = parseGrid("Eb6/9 G7(♯5) Gsus4(♭9)");
    expect(skipped).toEqual([]);
    expect(events.map((e) => e.data.symbol)).toEqual([
      "Eb6/9",
      "G7(♯5)",
      "Gsus4(♭9)",
    ]);
  });

  it("still treats a boundary ( as a bar group", () => {
    const { events, skipped } = parseGrid("(E E6)");
    expect(skipped).toEqual([]);
    // One bar split equally between the two chords.
    expect(events.map((e) => e.data.symbol)).toEqual(["E", "E6"]);
    expect(events[0]!.end - events[0]!.start).toBe(2);
  });

  it("nests an altered chord inside a group", () => {
    const { events, skipped } = parseGrid("(G7(♯5) A)");
    expect(skipped).toEqual([]);
    expect(events.map((e) => e.data.symbol)).toEqual(["G7(♯5)", "A"]);
  });

  it("preserves the empty () spacer as an empty bar", () => {
    const { events, skipped } = parseGrid("C\n()\nF");
    expect(skipped).toEqual([]);
    expect(events.map((e) => e.data.symbol)).toEqual(["C", "F"]);
    // The spacer bar sits between them (F starts two bars after C).
    expect(events[1]!.start - events[0]!.start).toBe(8);
  });

  it("still skips a genuine typo carrying parens", () => {
    const { skipped } = parseGrid("Zx(♯5)");
    expect(skipped).toEqual(["Zx(♯5)"]);
  });
});

describe("parseGrid — comments", () => {
  it("ignores a whole-line comment", () => {
    const { events, skipped } = parseGrid("; verse\nC G");
    expect(skipped).toEqual([]);
    expect(events.map((e) => e.data.symbol)).toEqual(["C", "G"]);
    // The comment consumes no bar — C still starts the grid.
    expect(events[0]!.start).toBe(0);
  });

  it("ignores a trailing comment after a bar", () => {
    expect(symbols("C G ; turnaround\nAm F")).toEqual(["C", "G", "Am", "F"]);
  });

  it("does not glue the next line into the commented cell", () => {
    const { events } = parseGrid("C ; aside\nG");
    expect(events.map((e) => e.data.symbol)).toEqual(["C", "G"]);
    expect(events[1]!.start).toBe(4);
  });

  it("comments out chords that would otherwise sound", () => {
    const { events, skipped } = parseGrid("C\n; Am F\nG");
    expect(skipped).toEqual([]);
    expect(events.map((e) => e.data.symbol)).toEqual(["C", "G"]);
    // G is the second bar — the commented line contributed no bars.
    expect(events[1]!.start).toBe(4);
  });

  it("treats a comment-only grid as empty, not as a typo", () => {
    const { events, skipped } = parseGrid("; nothing here yet");
    expect(events).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("terminates a comment at end-of-text without a newline", () => {
    expect(symbols("C G ;")).toEqual(["C", "G"]);
  });

  it("comments after the optional | bar separator", () => {
    expect(symbols("| C  G | ; tail")).toEqual(["C", "G"]);
  });

  it("comments inside a group, without breaking the group", () => {
    const { events, skipped } = parseGrid("(C ; first half\n G)");
    expect(skipped).toEqual([]);
    expect(events.map((e) => e.data.symbol)).toEqual(["C", "G"]);
    // Still one shared bar: two beats each.
    expect(events[0]!.end - events[0]!.start).toBe(2);
  });

  it("needs no space, and no cell boundary, to start a comment", () => {
    // `;` is not a musical character, so it never does double duty.
    expect(symbols(";verse\nC G")).toEqual(["C", "G"]);
    expect(symbols("C;tail\nG")).toEqual(["C", "G"]);
  });
});

describe("parseGrid — # is always a sharp, never a comment", () => {
  it("keeps a sharp inside a chord root", () => {
    expect(symbols("F#m C#7")).toEqual(["F#m", "C#7"]);
  });

  it("keeps a sharp inside an attached alteration", () => {
    const { events, skipped } = parseGrid("G7(#5)");
    expect(skipped).toEqual([]);
    // The theory layer canonicalizes the ASCII `#` alteration to `♯`.
    expect(events[0]!.data.symbol).toBe("G7(♯5)");
  });

  it("keeps a sharp on the first chord of a group", () => {
    expect(symbols("(C#m E)")).toEqual(["C#m", "E"]);
  });

  it("keeps a sharp after a hold", () => {
    expect(symbols("C . F#m")).toEqual(["C", "F#m"]);
  });

  it("still fails loud on a typo carrying a mid-token #", () => {
    expect(parseGrid("Zx#9").skipped).toEqual(["Zx#9"]);
  });

  it("reads a cell-opening # as a RAISED DEGREE — the reason `;` replaced it", () => {
    // Under the old `#`-comment rule this whole cell vanished.
    expect(symbols("I #iv° V")).toEqual(["C", "F#dim", "G"]);
    expect(symbols("#IV")).toEqual(["F#"]);
  });
});

describe("parseGrid — regression", () => {
  it("parses a plain progression unchanged", () => {
    expect(symbols("C G Am F")).toEqual(["C", "G", "Am", "F"]);
  });
});

describe("parseGrid — Roman numerals", () => {
  it("resolves degrees against the default key of C major", () => {
    const { events, skipped } = parseGrid("I vi IV V");
    expect(skipped).toEqual([]);
    expect(events.map((e) => e.data.symbol)).toEqual(["C", "Am", "F", "G"]);
  });

  it("reads the quality off the numeral's case, mark and figure", () => {
    expect(symbols("I Imaj7 I7 IV")).toEqual(["C", "Cmaj7", "C7", "F"]);
    expect(symbols("ii7 V7 Imaj7")).toEqual(["Dm7", "G7", "Cmaj7"]);
    expect(symbols("viiø7 vii°7 III+")).toEqual(["Bø7", "Bdim7", "E+"]);
  });

  it("mixes numerals and letter-name chords in one grid", () => {
    expect(symbols("C ii7 F# V")).toEqual(["C", "Dm7", "F#", "G"]);
  });

  it("holds and groups apply to numerals like any chord", () => {
    const { events, skipped } = parseGrid("I . (IV V)");
    expect(skipped).toEqual([]);
    expect(events.map((e) => e.data.symbol)).toEqual(["C", "F", "G"]);
    expect(events[0]!.end - events[0]!.start).toBe(8); // struck once, held a bar
    expect(events[1]!.end - events[1]!.start).toBe(2); // half a shared bar
  });

  it("spells the root through the key (♭VII in F reads E♭)", () => {
    const { events } = parseGrid("key: F\nbVII");
    expect(events[0]!.data.symbol).toBe("D#");
    expect(events[0]!.data.spelledSymbol).toBe("E♭");
  });

  it("fails loud on a numeral that is not in the vocabulary", () => {
    expect(parseGrid("I VIII vsus4").skipped).toEqual(["VIII", "vsus4"]);
  });
});

describe("parseGrid — the key: directive", () => {
  it("sets the key numerals resolve against", () => {
    expect(symbols("key: A\nI vi IV V")).toEqual(["A", "F#m", "D", "E"]);
  });

  it("accepts the tonic attached, and `=` for `:`", () => {
    expect(symbols("key:A I")).toEqual(["A"]);
    expect(symbols("key=A I")).toEqual(["A"]);
    expect(symbols("KEY: A I")).toEqual(["A"]);
  });

  it("reads degrees off the major scale in a minor key too", () => {
    // A minor: i iv ♭VI V — ♭VI is F, as the numeral is read back.
    expect(symbols("key: Am\ni iv bVI V")).toEqual(["Am", "Dm", "F", "E"]);
  });

  it("consumes no bar", () => {
    const { events } = parseGrid("key: C\nI\nV");
    expect(events[0]!.start).toBe(0);
    expect(events[1]!.start).toBe(4);
  });

  it("modulates from where it appears onward", () => {
    const { events, keys } = parseGrid("I V\nkey: D\nI V");
    expect(events.map((e) => e.data.symbol)).toEqual(["C", "G", "D", "A"]);
    expect(keys).toEqual([{ beat: 8, key: { tonic: "D", mode: "major" } }]);
  });

  it("reports the key changes it establishes, in beat order", () => {
    expect(parseGrid("key: G\nI\nkey: Em\ni").keys).toEqual([
      { beat: 0, key: { tonic: "G", mode: "major" } },
      { beat: 4, key: { tonic: "E", mode: "minor" } },
    ]);
  });

  it("declares no key when the grid has no directive", () => {
    expect(parseGrid("C G Am F").keys).toEqual([]);
  });

  it("fails loud on an unrecognised or missing tonic", () => {
    expect(parseGrid("key: H").skipped).toEqual(["key:H"]);
    expect(parseGrid("key:").skipped).toEqual(["key:"]);
  });

  it("leaves letter-name chords untouched by the key", () => {
    expect(symbols("key: Eb\nC G")).toEqual(["C", "G"]);
  });
});

/** Each token as `[text, kind]`, in source order. */
const spans = (text: string) =>
  parseGrid(text).tokens.map((t) => [text.slice(t.from, t.to), t.kind]);

describe("parseGrid — token spans", () => {
  it("classifies chords, degrees, holds and group parens", () => {
    expect(spans("Am7 vi . (E E6)")).toEqual([
      ["Am7", "chord"],
      ["vi", "degree"],
      [".", "hold"],
      ["(", "group-open"],
      ["E", "chord"],
      ["E6", "chord"],
      [")", "group-close"],
    ]);
  });

  it("keeps an attached alteration inside the chord span", () => {
    expect(spans("(G7(♯5) .)")).toEqual([
      ["(", "group-open"],
      ["G7(♯5)", "chord"],
      [".", "hold"],
      [")", "group-close"],
    ]);
  });

  it("keeps comments as spans, at their source offsets — even inside a group", () => {
    expect(spans("; Verse\nC ; aside\n(D ; x\n E)")).toEqual([
      ["; Verse", "comment"],
      ["C", "chord"],
      ["; aside", "comment"],
      ["(", "group-open"],
      ["D", "chord"],
      ["; x", "comment"],
      ["E", "chord"],
      [")", "group-close"],
    ]);
  });

  it("splits a key directive into its keyword and value", () => {
    expect(spans("key: Am\ni")).toEqual([
      ["key:", "key-directive"],
      ["Am", "key-value"],
      ["i", "degree"],
    ]);
    expect(spans("key=G")).toEqual([
      ["key=", "key-directive"],
      ["G", "key-value"],
    ]);
  });

  it("paints invalid exactly what was skipped", () => {
    const text = "C Zx VIII ) key: H";
    const { tokens, skipped } = parseGrid(text);
    expect(skipped).toEqual([")", "Zx", "VIII", "key:H"]);
    expect(
      tokens
        .filter((t) => t.kind === "invalid")
        .map((t) => text.slice(t.from, t.to)),
    ).toEqual(["Zx", "VIII", ")", "key:", "H"]);
  });

  it("paints an unterminated group's runs invalid, leaving its comments", () => {
    const { tokens, skipped } = parseGrid("C (D ; open\n E");
    expect(skipped).toEqual(["(D E"]);
    expect(tokens.map((t) => t.kind)).toEqual([
      "chord",
      "invalid",
      "comment",
      "invalid",
    ]);
  });

  it("reads a numeral under a modulated key as a degree", () => {
    expect(spans("key: D I")).toEqual([
      ["key:", "key-directive"],
      ["D", "key-value"],
      ["I", "degree"],
    ]);
  });
});

describe("parseGrid — bars", () => {
  it("counts one bar per top-level cell", () => {
    expect(parseGrid("C . (D E) ()").bars).toBe(4);
  });

  it("counts no bar for comments and key directives", () => {
    expect(parseGrid("; intro\nkey: G\nI V ; tail").bars).toBe(2);
  });

  it("counts a bar for a skipped chord (it still occupies its cell)", () => {
    expect(parseGrid("C Zx G").bars).toBe(3);
  });

  it("is zero for an empty grid", () => {
    expect(parseGrid("").bars).toBe(0);
  });
});
