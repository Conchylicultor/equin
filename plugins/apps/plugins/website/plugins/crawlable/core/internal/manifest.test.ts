import { describe, expect, test } from "bun:test";
import { SnapshotManifestSchema } from "./manifest";

const entry = {
  title: "Download",
  description: "One command.",
  file: "website/download.html",
};

describe("SnapshotManifestSchema", () => {
  test("accepts the contract's shape", () => {
    const manifest = {
      pages: { "/website": entry, "/website/download": entry },
    };
    expect(SnapshotManifestSchema.parse(manifest)).toEqual(manifest);
  });

  test("carries the home, a page of the snapshot", () => {
    const manifest = { home: "/website", pages: { "/website": entry } };
    expect(SnapshotManifestSchema.parse(manifest)).toEqual(manifest);
  });

  test("an empty page set is a manifest", () => {
    expect(SnapshotManifestSchema.parse({ pages: {} })).toEqual({ pages: {} });
  });

  test.each([
    ["an unknown top-level field", { pages: {}, version: 1 }],
    ["an unknown page field", { pages: { "/website": { ...entry, x: 1 } } }],
    ["a relative page path", { pages: { website: entry } }],
    ["a trailing slash", { pages: { "/website/": entry } }],
    [
      "an absolute file",
      { pages: { "/website": { ...entry, file: "/x.html" } } },
    ],
    [
      "a file escaping the dir",
      { pages: { "/website": { ...entry, file: "../x.html" } } },
    ],
    [
      "a file escaping mid-path",
      { pages: { "/website": { ...entry, file: "a/../../x.html" } } },
    ],
    ["a non-html file", { pages: { "/website": { ...entry, file: "x.txt" } } }],
    ["an empty title", { pages: { "/website": { ...entry, title: "" } } }],
    [
      "a home that is no page",
      { home: "/website/x", pages: { "/website": entry } },
    ],
    ["a home at /", { home: "/", pages: { "/": entry } }],
    ["a relative home", { home: "website", pages: { "/website": entry } }],
    ["an empty home", { home: "", pages: { "/website": entry } }],
  ])("refuses %s", (_, manifest) => {
    expect(SnapshotManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
