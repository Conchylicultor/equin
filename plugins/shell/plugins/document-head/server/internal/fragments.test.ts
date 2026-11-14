import { describe, it, expect } from "bun:test";

import {
  frameAncestorsByPath,
  matchHeadFragment,
  mergeHeadFragments,
} from "./fragments";

describe("matchHeadFragment", () => {
  it('picks the longest app path the path is in, else the "" entry', () => {
    const f = { "": "g", "/a": "a", "/a/b": "ab" };
    expect(matchHeadFragment(f, "/")).toBe("g");
    expect(matchHeadFragment(f, "/a")).toBe("a");
    expect(matchHeadFragment(f, "/a/x")).toBe("a");
    expect(matchHeadFragment(f, "/a/b/c")).toBe("ab");
    expect(matchHeadFragment(f, "/ab")).toBe("g");
    expect(matchHeadFragment({ "/a": "a" }, "/b")).toBe("");
  });
});

describe("mergeHeadFragments", () => {
  it("gives every key each source's own match, in source order", () => {
    const merged = mergeHeadFragments([
      { "": "T", "/home": "H" },
      { "": "x" },
      { "/pages": "P" },
    ]);
    expect(merged).toEqual({
      "": "Tx",
      "/home": "Hx",
      "/pages": "TxP",
    });
  });
});

describe("frameAncestorsByPath", () => {
  const ext = "chrome-extension://abc";
  it("keys each policy's ancestors by its path", () => {
    expect(
      frameAncestorsByPath([
        { id: "a", path: "/home/x", ancestors: [ext] },
        { id: "b", path: "/y", ancestors: ["'self'", ext] },
      ]),
    ).toEqual({ "/home/x": [ext], "/y": ["'self'", ext] });
  });
  it("refuses a path named twice", () => {
    expect(() =>
      frameAncestorsByPath([
        { id: "a", path: "/x", ancestors: [ext] },
        { id: "b", path: "/x", ancestors: [ext] },
      ]),
    ).toThrow("a and b both name /x");
  });
  it("refuses an ancestor that would end the directive", () => {
    for (const bad of [`${ext}; script-src *`, "a b", "a,b", ""]) {
      expect(() =>
        frameAncestorsByPath([{ id: "a", path: "/x", ancestors: [bad] }]),
      ).toThrow("is not one CSP source expression");
    }
  });
  it("refuses no ancestors and a path that is not an app path", () => {
    expect(() =>
      frameAncestorsByPath([{ id: "a", path: "/x", ancestors: [] }]),
    ).toThrow("no ancestors");
    for (const bad of ["x", "/", "/x/", "/x?y"]) {
      expect(() =>
        frameAncestorsByPath([{ id: "a", path: bad, ancestors: [ext] }]),
      ).toThrow("is not an app path");
    }
  });
});
