import { describe, expect, test } from "bun:test";
import {
  InvalidRelPathError,
  isWithinRel,
  joinRel,
  parseRelPath,
  relName,
  relParent,
  relPath,
  splitRel,
} from "./rel-path";

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch (err) {
    if (err instanceof URIError) return s;
    throw err;
  }
}

describe("RelPath", () => {
  test("segments join; no segments is the root", () => {
    expect<string>(relPath()).toBe("");
    expect<string>(relPath("a", "b.txt")).toBe("a/b.txt");
    expect<string>(joinRel(relPath("a"), "b", "c")).toBe("a/b/c");
    expect<string>(joinRel(relPath(), "x")).toBe("x");
    expect(splitRel(relPath("a", "b"))).toEqual(["a", "b"]);
    expect(relName(relPath("a", "b"))).toBe("b");
    expect<string>(relParent(relPath("a", "b"))).toBe("a");
    expect<string>(relParent(relPath("a"))).toBe("");
  });

  test("parse accepts a plain relative path", () => {
    expect<string>(parseRelPath("")).toBe("");
    expect<string>(parseRelPath("_picks/p.json")).toBe("_picks/p.json");
    expect<string>(parseRelPath(".hidden/…/日本.txt")).toBe(
      ".hidden/…/日本.txt",
    );
  });

  const bad = [
    "/etc/passwd",
    "..",
    "../x",
    "a/../b",
    "a/./b",
    ".",
    "a//b",
    "a/",
    "/",
    "a\\b",
    "..\\x",
    "a\0b",
    decodeURIComponent("%2e%2e"),
    decodeURIComponent("%2e%2e%2fetc"),
    decodeURIComponent("a%2f..%2f..%2fb"),
    decodeURIComponent("%2e"),
  ];
  for (const input of bad) {
    test(`parse refuses ${JSON.stringify(input)}`, () => {
      expect(() => parseRelPath(input)).toThrow(InvalidRelPathError);
    });
  }

  test("segment-wise construction refuses separators and dot segments", () => {
    for (const seg of ["", ".", "..", "a/b", "a\\b", "a\0"]) {
      expect(() => relPath(seg)).toThrow(InvalidRelPathError);
      expect(() => joinRel(relPath("ok"), seg)).toThrow(InvalidRelPathError);
    }
  });

  test("fuzz: whatever parses never escapes the root", () => {
    const alphabet = ["a", ".", "/", "\\", "%", "2", "e", "f", "\0", "..", "b"];
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 5_000; i++) {
      let s = "";
      const len = 1 + Math.floor(rand() * 10);
      for (let j = 0; j < len; j++)
        s += alphabet[Math.floor(rand() * alphabet.length)];
      for (const input of [s, safeDecode(s)]) {
        let parsed: string;
        try {
          parsed = parseRelPath(input);
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidRelPathError);
          continue;
        }
        expect(parsed.startsWith("/")).toBe(false);
        for (const seg of parsed === "" ? [] : parsed.split("/")) {
          expect(["", ".", ".."]).not.toContain(seg);
          expect(seg.includes("\\")).toBe(false);
          expect(seg.includes("\0")).toBe(false);
        }
      }
    }
  });

  test("isWithinRel", () => {
    expect(isWithinRel(relPath("a", "b"), relPath("a"))).toBe(true);
    expect(isWithinRel(relPath("a"), relPath("a"))).toBe(true);
    expect(isWithinRel(relPath("ab"), relPath("a"))).toBe(false);
    expect(isWithinRel(relPath("x"), relPath())).toBe(true);
  });
});
