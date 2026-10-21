import { describe, expect, test } from "bun:test";
import { parsePartialJson } from "./partial-json";

describe("parsePartialJson", () => {
  test("a complete document parses to itself", () => {
    const doc = { a: [1, 2.5, true, null], b: { c: 'd"\\\n\u00e9' } };
    expect(parsePartialJson(JSON.stringify(doc))).toEqual(doc);
    expect(parsePartialJson(JSON.stringify(doc, null, 2))).toEqual(doc);
    expect(parsePartialJson('["a"]')).toEqual(["a"]);
  });

  test("every prefix of a real tool input parses, and only grows", () => {
    const input = {
      file_path: "/tmp/a.ts",
      content: 'const x = "\\u00e9";\n\tif (a) { return [1, 2]; }\n',
      edits: [{ old_string: "a", new_string: "b", replace_all: false }],
      timeout: 12000,
    };
    for (const doc of [JSON.stringify(input), JSON.stringify(input, null, 2)]) {
      for (let n = 0; n <= doc.length; n++) {
        expect(() => parsePartialJson(doc.slice(0, n))).not.toThrow();
      }
      expect(parsePartialJson(doc)).toEqual(input);
    }
  });

  test("a string value is finished where it stands", () => {
    expect(parsePartialJson('{"file_path":"/tmp/a')).toEqual({
      file_path: "/tmp/a",
    });
    expect(parsePartialJson('["a","b')).toEqual(["a", "b"]);
  });

  test("a half-written escape is dropped", () => {
    expect(parsePartialJson('{"a":"x\\')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a":"x\\u00')).toEqual({ a: "x" });
    expect(parsePartialJson('{"a":"x\\n')).toEqual({ a: "x\n" });
  });

  test("a key, number or literal in progress is cut back", () => {
    expect(parsePartialJson("")).toBeUndefined();
    expect(parsePartialJson("4")).toBeUndefined();
    expect(parsePartialJson('{"file_pa')).toEqual({});
    expect(parsePartialJson('{"a":"b","c')).toEqual({ a: "b" });
    expect(parsePartialJson('{"a":')).toEqual({});
    expect(parsePartialJson('{"a":12')).toEqual({});
    expect(parsePartialJson('{"a":12,')).toEqual({ a: 12 });
    expect(parsePartialJson("[tru")).toEqual([]);
    expect(parsePartialJson('{"a":{"b":[1,')).toEqual({ a: { b: [1] } });
  });

  test("a prefix of no valid document is loud", () => {
    expect(() => parsePartialJson('{"a" "b"}')).toThrow();
  });
});
