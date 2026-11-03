import { describe, expect, test } from "bun:test";
import { compositeKey, isCompositeKey } from "./composite-key";

// The codec every key site of a composite-keyed collection derives from: an id
// must round-trip whatever its parts hold, never contain the point set's
// separator, and have exactly one spelling.

// Mirrors network/live's `isPointId` (not importable here: query-resource
// never imports network/live): what a `:rows` id set can carry.
const isPointId = (id: string) => id !== "" && !id.includes(",");

describe("compositeKey", () => {
  const key = compositeKey(["a", "b", "c"]);

  const adversarial: [string, string, string][] = [
    ["plain", "x", "y"],
    ["with,comma", "with/slash", "100%"],
    ["%2C", "%2F", "%"],
    ["", "", ""],
    ["é ü 中文 🎵", "tab\there", "new\nline"],
    ["a/b/c", ",,,", "//"],
  ];

  test("an id round-trips any parts, and is always a point id", () => {
    for (const [a, b, c] of adversarial) {
      const id = key.encode({ a, b, c });
      expect(isPointId(id)).toBe(true);
      expect(key.decode(id)).toEqual([a, b, c]);
      expect(key.encodeParts([a, b, c])).toBe(id);
    }
  });

  test("distinct parts never share an id", () => {
    const ids = new Set(
      adversarial.map(([a, b, c]) => key.encode({ a, b, c })),
    );
    expect(ids.size).toBe(adversarial.length);
    // The separator inside a part is escaped, so the split is unambiguous.
    expect(key.encode({ a: "x/y", b: "z", c: "w" })).not.toBe(
      key.encode({ a: "x", b: "y/z", c: "w" }),
    );
  });

  test("an integer part is its decimal text — what Postgres's `int::text` carries", () => {
    const k = compositeKey(["conversationId", "occurrenceIndex"]);
    expect(k.encode({ conversationId: "conv-1", occurrenceIndex: 7 })).toBe(
      k.encodeParts(["conv-1", "7"]),
    );
    expect(() =>
      k.encode({ conversationId: "conv-1", occurrenceIndex: 1.5 }),
    ).toThrow(/string or a safe integer/);
    expect(() =>
      k.encode({ conversationId: "conv-1", occurrenceIndex: null }),
    ).toThrow(/string or a safe integer/);
  });

  test("decode refuses a foreign or non-canonical id (null, never a throw)", () => {
    expect(key.decode("x/y")).toBeNull(); // too few parts
    expect(key.decode("x/y/z/w")).toBeNull(); // too many
    expect(key.decode("x/%E0%A4%A/z")).toBeNull(); // a malformed escape
    expect(key.decode("%41/y/z")).toBeNull(); // `A` spelled escaped: not the encoder's
    expect(key.decode("x/%2c/z")).toBeNull(); // a lower-case escape
    expect(key.decode("")).toBeNull();
  });

  test("the declaration is refused outside 2…8 distinct fields", () => {
    expect(() => compositeKey(["a"] as unknown as ["a", "a"])).toThrow(
      /at least two fields/,
    );
    expect(() => compositeKey(["a", "a"])).toThrow(/named twice/);
    expect(() =>
      compositeKey(["a", "b", "c", "d", "e", "f", "g", "h", "i"]),
    ).toThrow(/at most 8/);
    expect(() => key.encodeParts(["x", "y"])).toThrow(/2 parts for 3 fields/);
  });

  test("isCompositeKey tells a codec from a field name", () => {
    expect(isCompositeKey(key)).toBe(true);
    expect(isCompositeKey("id")).toBe(false);
    expect(isCompositeKey(null)).toBe(false);
  });
});
