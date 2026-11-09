import { describe, expect, test } from "bun:test";
import { readableJson } from "./readable-json";

describe("readableJson", () => {
  test("matches JSON.stringify when no string holds a newline", () => {
    const v = { a: 1, b: ["x", { c: null }], d: 'q"uote\\n' };
    expect(readableJson(v)).toBe(JSON.stringify(v, null, 2));
  });

  test("breaks a multi-line string, indented below its key", () => {
    expect(readableJson({ outer: { text: "one\ntwo\r\nthree" } })).toBe(
      [
        "{",
        '  "outer": {',
        '    "text": "one',
        "      two",
        '      three"',
        "  }",
        "}",
      ].join("\n"),
    );
  });

  test("keeps a literal backslash-n and escaped quotes", () => {
    expect(readableJson(["a\\nb", 'say "hi"\nbye'])).toBe(
      ["[", '  "a\\\\nb",', '  "say \\"hi\\"', '    bye"', "]"].join("\n"),
    );
  });

  test("breaks newlines inside keys too", () => {
    expect(readableJson({ "k\nk": 1 })).toBe('{\n  "k\n    k": 1\n}');
  });

  test("undefined renders as its name", () => {
    expect(readableJson(undefined)).toBe("undefined");
  });
});
