import { describe, expect, test } from "bun:test";
import { SnapshotManifestSchema } from "./manifest";
import { defineWebsitePage } from "./page";
import {
  fragmentText,
  SnapshotPageError,
  snapshotFileOf,
  snapshotFiles,
} from "./snapshot";

const landing = defineWebsitePage({
  path: "/about",
  title: "equin",
  description: "The app.",
});
const download = defineWebsitePage({
  path: "/about/download",
  title: "Download",
  description: "One command.",
});

describe("snapshotFileOf", () => {
  test("the path, relative, as .html", () => {
    expect(snapshotFileOf("/about")).toBe("about.html");
    expect(snapshotFileOf("/about/download")).toBe("about/download.html");
  });
  test.each(["website", "/", "/about/"])("refuses %p", (p) => {
    expect(() => snapshotFileOf(p)).toThrow(SnapshotPageError);
  });
});

describe("fragmentText", () => {
  test("drops tags and collapses whitespace", () => {
    expect(fragmentText('<h1>Hi</h1>\n<p>a  <a href="/x">b</a></p>')).toBe(
      "Hi a b",
    );
  });
});

describe("snapshotFiles", () => {
  test("a manifest the contract accepts, one fragment per page", () => {
    const { manifest, fragments } = snapshotFiles(
      [
        { page: landing, title: "equin", semantic: "<h1>equin</h1>" },
        { page: download, title: "Download — equin", semantic: "<p>Run</p>" },
      ],
      "/about",
    );
    expect(SnapshotManifestSchema.parse(manifest)).toEqual({
      home: "/about",
      pages: {
        "/about": {
          title: "equin",
          description: "The app.",
          file: "about.html",
        },
        "/about/download": {
          title: "Download — equin",
          description: "One command.",
          file: "about/download.html",
        },
      },
    });
    expect([...fragments]).toEqual([
      ["about.html", "<h1>equin</h1>"],
      ["about/download.html", "<p>Run</p>"],
    ]);
  });
  test("a page with no text fails, naming it", () => {
    expect(() =>
      snapshotFiles(
        [{ page: download, title: "D", semantic: "<p> <br/> </p>" }],
        null,
      ),
    ).toThrow("/about/download");
  });
  test("no home: the manifest carries none", () => {
    const { manifest } = snapshotFiles(
      [{ page: download, title: "D", semantic: "<p>a</p>" }],
      null,
    );
    expect(manifest).toEqual({
      pages: {
        "/about/download": {
          title: "D",
          description: "One command.",
          file: "about/download.html",
        },
      },
    });
  });
  test("what moved is carried, and omitted when nothing did", () => {
    const taken = [{ page: download, title: "D", semantic: "<p>a</p>" }];
    expect(
      snapshotFiles(taken, null, { "/website": "/about" }).manifest.moved,
    ).toEqual({ "/website": "/about" });
    expect("moved" in snapshotFiles(taken, null, {}).manifest).toBe(false);
  });
  test("a home that is no taken page fails, naming it", () => {
    expect(() =>
      snapshotFiles(
        [{ page: download, title: "D", semantic: "<p>a</p>" }],
        "/about",
      ),
    ).toThrow(/\/about: the composition's home is no declared page/);
  });
  test("a path taken twice fails", () => {
    expect(() =>
      snapshotFiles(
        [
          { page: download, title: "D", semantic: "<p>a</p>" },
          { page: download, title: "D", semantic: "<p>a</p>" },
        ],
        null,
      ),
    ).toThrow("declared twice");
  });
});
