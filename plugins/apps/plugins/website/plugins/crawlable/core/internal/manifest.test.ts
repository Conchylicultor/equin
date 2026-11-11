import { describe, expect, test } from "bun:test";
import { SnapshotManifestSchema } from "./manifest";

const entry = {
  title: "Download",
  description: "One command.",
  file: "about/download.html",
};

describe("SnapshotManifestSchema", () => {
  test("accepts the contract's shape", () => {
    const manifest = {
      pages: { "/about": entry, "/about/download": entry },
    };
    expect(SnapshotManifestSchema.parse(manifest)).toEqual(manifest);
  });

  test("carries the home, a page of the snapshot", () => {
    const manifest = { home: "/about", pages: { "/about": entry } };
    expect(SnapshotManifestSchema.parse(manifest)).toEqual(manifest);
  });

  test("carries what moved, former base path to new", () => {
    const manifest = {
      moved: { "/website": "/about" },
      pages: { "/about": entry },
    };
    expect(SnapshotManifestSchema.parse(manifest)).toEqual(manifest);
  });

  test.each([
    ["from the root", { "/": "/about" }],
    ["to itself", { "/about": "/about" }],
    ["over a page", { "/about": "/elsewhere" }],
  ])("refuses a move %s", (_, moved) => {
    expect(() =>
      SnapshotManifestSchema.parse({ moved, pages: { "/about": entry } }),
    ).toThrow();
  });

  test("an empty page set is a manifest", () => {
    expect(SnapshotManifestSchema.parse({ pages: {} })).toEqual({ pages: {} });
  });

  test.each([
    ["an unknown top-level field", { pages: {}, version: 1 }],
    ["an unknown page field", { pages: { "/about": { ...entry, x: 1 } } }],
    ["a relative page path", { pages: { website: entry } }],
    ["a trailing slash", { pages: { "/about/": entry } }],
    [
      "an absolute file",
      { pages: { "/about": { ...entry, file: "/x.html" } } },
    ],
    [
      "a file escaping the dir",
      { pages: { "/about": { ...entry, file: "../x.html" } } },
    ],
    [
      "a file escaping mid-path",
      { pages: { "/about": { ...entry, file: "a/../../x.html" } } },
    ],
    ["a non-html file", { pages: { "/about": { ...entry, file: "x.txt" } } }],
    ["an empty title", { pages: { "/about": { ...entry, title: "" } } }],
    [
      "a home that is no page",
      { home: "/about/x", pages: { "/about": entry } },
    ],
    ["a home at /", { home: "/", pages: { "/": entry } }],
    ["a relative home", { home: "website", pages: { "/about": entry } }],
    ["an empty home", { home: "", pages: { "/about": entry } }],
  ])("refuses %s", (_, manifest) => {
    expect(SnapshotManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
