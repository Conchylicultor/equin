import { describe, expect, test } from "bun:test";
import { compareRowKeys, inRange, sliceRange } from "./key-order";

describe("compareRowKeys", () => {
  test("each part in its direction, then the id ascending", () => {
    const order = ["asc", "desc"] as const;
    expect(compareRowKeys(["a", "2", "x"], ["b", "1", "x"], order)).toBe(-1);
    expect(compareRowKeys(["a", "2", "x"], ["a", "1", "x"], order)).toBe(-1);
    expect(compareRowKeys(["a", "1", "x"], ["a", "2", "x"], order)).toBe(1);
    expect(compareRowKeys(["a", "1", "x"], ["a", "1", "y"], order)).toBe(-1);
    expect(compareRowKeys(["a", "1", "x"], ["a", "1", "x"], order)).toBe(0);
  });

  test("a NULL part sorts last in either direction", () => {
    expect(compareRowKeys([null, "x"], ["z", "x"], ["asc"])).toBe(1);
    expect(compareRowKeys([null, "x"], ["z", "x"], ["desc"])).toBe(1);
    expect(compareRowKeys(["z", "x"], [null, "x"], ["desc"])).toBe(-1);
    expect(compareRowKeys([null, "a"], [null, "b"], ["desc"])).toBe(-1);
  });

  test("text compares by code point, an astral character after U+FFFF's neighbours", () => {
    // UTF-16 code units would put "😀" (D83D …) before "�".
    expect(compareRowKeys(["�", "a"], ["😀", "a"], ["asc"])).toBe(-1);
    expect(compareRowKeys(["ab", "a"], ["b", "a"], ["asc"])).toBe(-1);
    expect(compareRowKeys(["a", "a"], ["ab", "a"], ["asc"])).toBe(-1);
  });

  test("an order of no parts is the id alone", () => {
    expect(compareRowKeys(["a"], ["b"], [])).toBe(-1);
  });
});

describe("inRange", () => {
  const order = ["desc"] as const;
  const range = {
    after: { key: ["5"], id: "e" },
    until: { key: ["2"], id: "b" },
  };
  test("(after, until]: after is exclusive, until inclusive", () => {
    expect(inRange(["5", "e"], range, order)).toBe(false);
    expect(inRange(["5", "f"], range, order)).toBe(true);
    expect(inRange(["3", "c"], range, order)).toBe(true);
    expect(inRange(["2", "b"], range, order)).toBe(true);
    expect(inRange(["2", "c"], range, order)).toBe(false);
    expect(inRange(["1", "a"], range, order)).toBe(false);
  });
  test("null ends are the order's start and end", () => {
    expect(inRange(["9", "z"], { after: null, until: null }, order)).toBe(true);
  });
});

describe("sliceRange", () => {
  type Item = { id: string; at: string | null };
  const value = {
    paged: {
      id: "id",
      key: { of: (i: Item) => [i.at], order: ["desc"] as const },
    },
  };
  const items: Item[] = [
    { id: "a", at: "1" },
    { id: "b", at: "3" },
    { id: "c", at: null },
    { id: "d", at: "3" },
    { id: "e", at: "2" },
  ];
  const ids = (xs: readonly Item[]) => xs.map((x) => x.id);

  test("sorts, cuts and limits — without touching its input", () => {
    const before = JSON.stringify(items);
    expect(
      ids(sliceRange(value, items, { after: null, until: null, limit: 10 })),
    ).toEqual(["b", "d", "e", "a", "c"]);
    expect(
      ids(sliceRange(value, items, { after: null, until: null, limit: 2 })),
    ).toEqual(["b", "d"]);
    expect(
      ids(
        sliceRange(value, items, {
          after: { key: ["3"], id: "b" },
          until: { key: ["1"], id: "a" },
          limit: 10,
        }),
      ),
    ).toEqual(["d", "e", "a"]);
    expect(JSON.stringify(items)).toBe(before);
  });

  test("a cut whose row is gone still bounds its range", () => {
    expect(
      ids(
        sliceRange(value, items, {
          after: { key: ["2"], id: "zz" },
          until: null,
          limit: 10,
        }),
      ),
    ).toEqual(["a", "c"]);
  });
});
