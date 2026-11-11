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
  path: "/website",
  title: "equin",
  description: "The app.",
});
const download = defineWebsitePage({
  path: "/website/download",
  title: "Download",
  description: "One command.",
});

describe("snapshotFileOf", () => {
  test("the path, relative, as .html", () => {
    expect(snapshotFileOf("/website")).toBe("website.html");
    expect(snapshotFileOf("/website/download")).toBe("website/download.html");
  });
  test.each(["website", "/", "/website/"])("refuses %p", (p) => {
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
      "/website",
    );
    expect(SnapshotManifestSchema.parse(manifest)).toEqual({
      home: "/website",
      pages: {
        "/website": {
          title: "equin",
          description: "The app.",
          file: "website.html",
        },
        "/website/download": {
          title: "Download — equin",
          description: "One command.",
          file: "website/download.html",
        },
      },
    });
    expect([...fragments]).toEqual([
      ["website.html", "<h1>equin</h1>"],
      ["website/download.html", "<p>Run</p>"],
    ]);
  });
  test("a page with no text fails, naming it", () => {
    expect(() =>
      snapshotFiles(
        [{ page: download, title: "D", semantic: "<p> <br/> </p>" }],
        null,
      ),
    ).toThrow("/website/download");
  });
  test("no home: the manifest carries none", () => {
    const { manifest } = snapshotFiles(
      [{ page: download, title: "D", semantic: "<p>a</p>" }],
      null,
    );
    expect(manifest).toEqual({
      pages: {
        "/website/download": {
          title: "D",
          description: "One command.",
          file: "website/download.html",
        },
      },
    });
  });
  test("a home that is no taken page fails, naming it", () => {
    expect(() =>
      snapshotFiles(
        [{ page: download, title: "D", semantic: "<p>a</p>" }],
        "/website",
      ),
    ).toThrow(/\/website: the composition's home is no declared page/);
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
