import { test, expect, describe } from "bun:test";
import {
  joinAroundSpan,
  normalizeSpan,
  stepTextOffset,
  type SpanLines,
} from "./text-span";

const TEXT: Record<string, string | null> = {
  A: "hello",
  B: "middle",
  IMG: null,
  C: "world",
  CHIP: "see [[page:abc]] here",
};

function lines(ids: string[], groups: Record<string, string> = {}): SpanLines {
  return {
    order: ids.map((id) => ({ id, group: groups[id] ?? "p1" })),
    textOf: (id) => TEXT[id] ?? null,
    tokenPatterns: [/\[\[page:[a-z]+\]\]/],
  };
}

describe("normalizeSpan", () => {
  test("orders the ends by visible order, keeping the drawn direction", () => {
    const out = normalizeSpan(
      { blockId: "C", offset: 2 },
      { blockId: "A", offset: 3 },
      lines(["A", "B", "C"]),
    );
    expect(out).toEqual({
      kind: "text",
      anchor: { blockId: "C", offset: 2 },
      head: { blockId: "A", offset: 3 },
      from: { blockId: "A", offset: 3 },
      to: { blockId: "C", offset: 2 },
    });
  });

  test("a span inside one block is legal, ordered by offset", () => {
    const out = normalizeSpan(
      { blockId: "A", offset: 4 },
      { blockId: "A", offset: 1 },
      lines(["A"]),
    );
    expect(out.kind).toBe("text");
    if (out.kind !== "text") return;
    expect(out.from.offset).toBe(1);
    expect(out.to.offset).toBe(4);
  });

  test("offsets clamp into the line's text", () => {
    const out = normalizeSpan(
      { blockId: "A", offset: -3 },
      { blockId: "C", offset: 99 },
      lines(["A", "C"]),
    );
    if (out.kind !== "text") throw new Error(out.kind);
    expect(out.from.offset).toBe(0);
    expect(out.to.offset).toBe(5);
  });

  test("an end on a text-less line widens the span to blocks", () => {
    expect(
      normalizeSpan(
        { blockId: "A", offset: 1 },
        { blockId: "IMG", offset: 0 },
        lines(["A", "IMG"]),
      ),
    ).toEqual({ kind: "blocks", anchor: "A", head: "IMG" });
  });

  test("a text-less line BETWEEN the ends does not widen it", () => {
    expect(
      normalizeSpan(
        { blockId: "A", offset: 1 },
        { blockId: "C", offset: 1 },
        lines(["A", "IMG", "C"]),
      ).kind,
    ).toBe("text");
  });

  test("a span reaching into another page widens to blocks", () => {
    expect(
      normalizeSpan(
        { blockId: "A", offset: 1 },
        { blockId: "C", offset: 1 },
        lines(["A", "B", "C"], { B: "sub" }),
      ).kind,
    ).toBe("blocks");
  });

  test("an end on no visible line is none", () => {
    expect(
      normalizeSpan(
        { blockId: "A", offset: 1 },
        { blockId: "gone", offset: 1 },
        lines(["A"]),
      ).kind,
    ).toBe("none");
  });

  test("ends inside a token snap OUTWARD, so the token is covered whole", () => {
    // "see [[page:abc]] here": the token spans [4, 16).
    const forward = normalizeSpan(
      { blockId: "CHIP", offset: 6 },
      { blockId: "CHIP", offset: 18 },
      lines(["CHIP"]),
    );
    if (forward.kind !== "text") throw new Error(forward.kind);
    expect(forward.from.offset).toBe(4);
    const backward = normalizeSpan(
      { blockId: "CHIP", offset: 1 },
      { blockId: "CHIP", offset: 10 },
      lines(["CHIP"]),
    );
    if (backward.kind !== "text") throw new Error(backward.kind);
    expect(backward.to.offset).toBe(16);
    // A boundary is already a legal cut.
    const onEdge = normalizeSpan(
      { blockId: "CHIP", offset: 4 },
      { blockId: "CHIP", offset: 16 },
      lines(["CHIP"]),
    );
    if (onEdge.kind !== "text") throw new Error(onEdge.kind);
    expect([onEdge.from.offset, onEdge.to.offset]).toEqual([4, 16]);
  });
});

describe("joinAroundSpan", () => {
  test("keeps marks on both sides of the join", () => {
    expect(
      joinAroundSpan(
        [{ text: "hel", marks: ["bold"] }, { text: "lo" }],
        2,
        [{ text: "wor" }, { text: "ld", marks: ["italic"] }],
        4,
      ),
    ).toEqual([
      { text: "he", marks: ["bold"] },
      { text: "d", marks: ["italic"] },
    ]);
  });

  test("typed text lands between, wearing the marks typing there would", () => {
    expect(
      joinAroundSpan(
        [{ text: "hel", marks: ["bold"] }, { text: "lo" }],
        2,
        [{ text: "world" }],
        3,
        "x",
      ),
    ).toEqual([{ text: "hex", marks: ["bold"] }, { text: "ld" }]);
  });

  test("typed at a line's very start, the text is plain", () => {
    expect(
      joinAroundSpan([{ text: "ab" }], 0, [{ text: "cd" }], 1, "x"),
    ).toEqual([{ text: "xd" }]);
  });
});

describe("stepTextOffset", () => {
  const PAGE = [/\[\[page:[a-z]+\]\]/];

  test("one character at a time inside plain text", () => {
    expect(stepTextOffset("hello", 2, "right")).toBe(3);
    expect(stepTextOffset("hello", 2, "left")).toBe(1);
  });

  test("null at the edge it travels toward — the step crosses lines there", () => {
    expect(stepTextOffset("hello", 5, "right")).toBeNull();
    expect(stepTextOffset("hello", 0, "left")).toBeNull();
    expect(stepTextOffset("", 0, "right")).toBeNull();
  });

  test("a token is one step, in both directions", () => {
    const text = "see [[page:abc]] here";
    expect(stepTextOffset(text, 4, "right", PAGE)).toBe(16);
    expect(stepTextOffset(text, 16, "left", PAGE)).toBe(4);
    // Off either side of it, ordinary characters again.
    expect(stepTextOffset(text, 16, "right", PAGE)).toBe(17);
    expect(stepTextOffset(text, 4, "left", PAGE)).toBe(3);
  });

  test("a surrogate pair is one character", () => {
    const text = "a😀b";
    expect(stepTextOffset(text, 1, "right")).toBe(3);
    expect(stepTextOffset(text, 3, "left")).toBe(1);
  });
});
