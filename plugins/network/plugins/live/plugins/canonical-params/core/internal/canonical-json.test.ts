import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./canonical-json";

describe("canonicalJson", () => {
  test("sorts object keys at every depth", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }),
    ).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  test("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("encodes scalars as JSON does", () => {
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson(null)).toBe("null");
  });

  test("an undefined property is absent", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("a null-prototype object is plain", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.x = 1;
    expect(canonicalJson(o)).toBe('{"x":1}');
  });

  test.each<[string, unknown]>([
    ["undefined", undefined],
    ["undefined in an array", [1, undefined]],
    ["NaN", { a: Number.NaN }],
    ["Infinity", [Number.POSITIVE_INFINITY]],
    ["a Date", { at: new Date(0) }],
    ["a Map", new Map()],
    ["a class instance", new (class Thing {})()],
    ["a function", { f: () => 1 }],
    ["a bigint", 1n],
    ["a symbol", Symbol("s")],
  ])("refuses %s", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(/not plain JSON/);
  });

  test("refuses a cycle", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/a cycle/);
  });

  test("a shared (non-cyclic) reference encodes twice", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe(
      '{"a":{"x":1},"b":{"x":1}}',
    );
  });
});
