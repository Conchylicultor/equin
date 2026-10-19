import { describe, it, expect } from "bun:test";

import { matchHeadFragment, mergeHeadFragments } from "./fragments";

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
