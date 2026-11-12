import { describe, expect, test } from "bun:test";
import {
  CONFIG_HASH_RE,
  parseConfigFile,
  parseOverrideFile,
} from "./config-file";

describe("parseConfigFile", () => {
  test("the header's hash and the JSONC body, comments and all", () => {
    expect(
      parseConfigFile(
        '// @hash abc123\n// @legend a note\n{ "a": 1, // trailing\n}\n',
        "x/config.jsonc",
      ),
    ).toEqual({ content: { a: 1 }, hash: "abc123" });
  });

  test("a hashless file is corrupt: it throws, naming where", () => {
    expect(() => parseConfigFile('{ "a": 1 }', "x/config.jsonc")).toThrow(
      /x\/config\.jsonc/,
    );
  });

  test("CONFIG_HASH_RE matches only a line-1 header", () => {
    expect(CONFIG_HASH_RE.exec("// @hash 0f\n{}")?.[1]).toBe("0f");
    expect(CONFIG_HASH_RE.exec("{}\n// @hash 0f\n")).toBeNull();
  });
});

describe("parseOverrideFile", () => {
  test("a stamped override reads like any config file", () => {
    expect(parseOverrideFile('// @hash abc123\n{ "a": 1 }\n')).toEqual({
      content: { a: 1 },
      hash: "abc123",
    });
  });

  test("a hand-written override without a header is unstamped, not corrupt", () => {
    expect(parseOverrideFile('// mine\n{ "a": 1 }\n')).toEqual({
      content: { a: 1 },
      hash: null,
    });
  });

  test("text that does not parse says where, instead of passing off a salvage", () => {
    const read = parseOverrideFile('// @hash abc\n{ "a": 1\n  "b": 2 }\n');
    expect(read.hash).toBe("abc");
    expect(read.syntaxErrors?.[0]).toMatch(/JSONC syntax error: .* at line 3/);
  });

  test("a trailing comma is fine", () => {
    expect(parseOverrideFile('{ "a": 1, }').syntaxErrors).toBeUndefined();
  });
});
