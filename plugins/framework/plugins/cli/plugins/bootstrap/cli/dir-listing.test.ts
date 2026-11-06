import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFilesWithListing } from "./dir-listing";

const SKIP = new Set(["node_modules", ".git"]);
const KEEP = new Set([
  "package.json",
  "new.json",
  "inner.json",
  "sneaky.json",
  "later.json",
]);
const keep = (name: string): boolean => KEEP.has(name);

/** The answer a plain recursive readdir walk gives: the oracle. */
function fullWalk(root: string, rel: string, out: string[]): string[] {
  const abs = rel === "" ? root : join(root, rel);
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const child = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) fullWalk(root, child, out);
    } else if (e.isFile() && keep(e.name)) out.push(child);
  }
  return out;
}

let root: string;
let listing: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dir-listing-"));
  listing = join(root, "listing.json");
  mkdirSync(join(root, "ws/a/sub/b"), { recursive: true });
  mkdirSync(join(root, "ws/a/node_modules/x"), { recursive: true });
  writeFileSync(join(root, "ws/a/package.json"), "{}");
  writeFileSync(join(root, "ws/a/sub/b/package.json"), "{}");
  writeFileSync(join(root, "ws/a/node_modules/x/package.json"), "{}");
  writeFileSync(join(root, "ws/a/ignored.txt"), "");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function walk(): { files: string[]; relisted: number } {
  const w = walkFilesWithListing(root, ["ws"], SKIP, KEEP, listing);
  return { files: [...w.files].sort(), relisted: w.relisted };
}

function oracle(): string[] {
  return fullWalk(root, "ws", []).sort();
}

describe("walkFilesWithListing", () => {
  test("equals a full walk, and a second walk re-lists nothing", () => {
    const first = walk();
    expect(first.files).toEqual(oracle());
    expect(first.files).not.toContain("ws/a/node_modules/x/package.json");
    expect(first.relisted).toBeGreaterThan(0);
    const second = walk();
    expect(second.files).toEqual(oracle());
    expect(second.relisted).toBe(0);
  });

  test("follows every kind of change", () => {
    walk();
    const steps: Array<() => void> = [
      // a new file in an existing directory
      () => writeFileSync(join(root, "ws/a/sub/b/new.json"), "{}"),
      // a new nested directory with an input inside
      () => {
        mkdirSync(join(root, "ws/c/sub/d"), { recursive: true });
        writeFileSync(join(root, "ws/c/sub/d/package.json"), "{}");
      },
      // a removed directory
      () => rmSync(join(root, "ws/c"), { recursive: true }),
      // a directory renamed
      () => renameSync(join(root, "ws/a/sub/b"), join(root, "ws/a/sub/e")),
      // a file replaced by a directory of the same name
      () => {
        rmSync(join(root, "ws/a/package.json"));
        mkdirSync(join(root, "ws/a/package.json"));
        writeFileSync(join(root, "ws/a/package.json/inner.json"), "{}");
      },
      // a change whose directory mtime is then restored (ctime still moves)
      () => {
        const dir = join(root, "ws/a/sub/e");
        const before = statSync(dir);
        writeFileSync(join(dir, "sneaky.json"), "{}");
        utimesSync(dir, before.atime, before.mtime);
      },
      // a symlink to a directory is never followed
      () => symlinkSync(join(root, "ws/a"), join(root, "ws/link")),
    ];
    for (const step of steps) {
      step();
      expect(walk().files).toEqual(oracle());
    }
  });

  test("a record made under another filter is no record", () => {
    walk();
    writeFileSync(join(root, "ws/a/extra.txt"), "");
    const wider = new Set([...KEEP, "extra.txt"]);
    // Same directory stamps; only the filter moved.
    const w = walkFilesWithListing(root, ["ws"], SKIP, wider, listing);
    expect(w.files).toContain("ws/a/extra.txt");
  });

  test("never creates the record's directory", () => {
    const nested = join(root, "absent-dir", "listing.json");
    walkFilesWithListing(root, ["ws"], SKIP, KEEP, nested);
    expect(existsSync(join(root, "absent-dir"))).toBe(false);
  });

  test("an unreadable record is a full walk", () => {
    walk();
    writeFileSync(listing, "{not json");
    writeFileSync(join(root, "ws/a/later.json"), "{}");
    expect(walk().files).toEqual(oracle());
  });
});
