import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostFsMoveResolution } from "../../core";
import { moveHostPaths, movePath } from "./move";

let root: string;
let cases = 0;

/** A fresh case folder holding `src/` and `dest/` (real paths: macOS's /tmp is a symlink). */
function caseDirs(): { src: string; dest: string } {
  const dir = join(root, `case-${cases++}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "dest"));
  return { src: join(dir, "src"), dest: join(dir, "dest") };
}

const none = new Map<string, HostFsMoveResolution>();

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "host-fs-move-test-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("moveHostPaths", () => {
  test("moves files and folders into the destination", async () => {
    const { src, dest } = caseDirs();
    writeFileSync(join(src, "a.txt"), "A");
    mkdirSync(join(src, "docs"));
    writeFileSync(join(src, "docs/b.txt"), "B");
    expect(
      await moveHostPaths([join(src, "a.txt"), join(src, "docs")], dest, none),
    ).toEqual({
      kind: "ok",
      destDir: dest,
      results: [
        { kind: "moved", from: join(src, "a.txt"), to: join(dest, "a.txt") },
        { kind: "moved", from: join(src, "docs"), to: join(dest, "docs") },
      ],
    });
    expect(readdirSync(src)).toEqual([]);
    expect(readFileSync(join(dest, "docs/b.txt"), "utf8")).toBe("B");
  });

  test("a folder cannot go into itself or a descendant", async () => {
    const { src } = caseDirs();
    mkdirSync(join(src, "a/b"), { recursive: true });
    const from = join(src, "a");
    expect(await moveHostPaths([from], from, none)).toMatchObject({
      results: [{ kind: "into-self", from }],
    });
    expect(await moveHostPaths([from], join(from, "b"), none)).toMatchObject({
      results: [{ kind: "into-self", from }],
    });
    expect(existsSync(join(src, "a/b"))).toBe(true);
  });

  test("a source already in the destination is left alone", async () => {
    const { src } = caseDirs();
    writeFileSync(join(src, "a.txt"), "A");
    expect(await moveHostPaths([join(src, "a.txt")], src, none)).toMatchObject({
      results: [{ kind: "same-dir", from: join(src, "a.txt") }],
    });
  });

  test("a taken name answers exists and moves nothing; the others still move", async () => {
    const { src, dest } = caseDirs();
    writeFileSync(join(src, "a.txt"), "new");
    writeFileSync(join(src, "b.txt"), "B");
    writeFileSync(join(dest, "a.txt"), "old");
    expect(
      await moveHostPaths([join(src, "a.txt"), join(src, "b.txt")], dest, none),
    ).toMatchObject({
      results: [
        { kind: "exists", from: join(src, "a.txt"), to: join(dest, "a.txt") },
        { kind: "moved", to: join(dest, "b.txt") },
      ],
    });
    expect(readFileSync(join(src, "a.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("old");
  });

  test("keep-both takes the Finder's next free name", async () => {
    const { src, dest } = caseDirs();
    writeFileSync(join(src, "a.txt"), "new");
    mkdirSync(join(src, "docs"));
    writeFileSync(join(dest, "a.txt"), "old");
    writeFileSync(join(dest, "a 2.txt"), "old 2");
    mkdirSync(join(dest, "docs"));
    const from = [join(src, "a.txt"), join(src, "docs")];
    const resolutions = new Map<string, HostFsMoveResolution>(
      from.map((f) => [f, "keep-both"]),
    );
    expect(await moveHostPaths(from, dest, resolutions)).toMatchObject({
      results: [
        { kind: "moved", to: join(dest, "a 3.txt") },
        { kind: "moved", to: join(dest, "docs 2") },
      ],
    });
    expect(readFileSync(join(dest, "a 3.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("old");
  });

  test("replace swaps the taken entry for the source", async () => {
    const { src, dest } = caseDirs();
    mkdirSync(join(src, "docs"));
    writeFileSync(join(src, "docs/new.txt"), "N");
    mkdirSync(join(dest, "docs"));
    writeFileSync(join(dest, "docs/old.txt"), "O");
    const from = join(src, "docs");
    expect(
      await moveHostPaths([from], dest, new Map([[from, "replace"]])),
    ).toMatchObject({ results: [{ kind: "moved", to: join(dest, "docs") }] });
    expect(readdirSync(join(dest, "docs"))).toEqual(["new.txt"]);
    // Nothing set aside is left behind.
    expect(readdirSync(dest)).toEqual(["docs"]);
  });

  test("replace refuses to delete a folder that holds the source", async () => {
    const { dest } = caseDirs();
    mkdirSync(join(dest, "a/a"), { recursive: true });
    const from = join(dest, "a/a");
    expect(
      await moveHostPaths([from], dest, new Map([[from, "replace"]])),
    ).toMatchObject({
      results: [{ kind: "replaces-ancestor", from, to: join(dest, "a") }],
    });
    expect(existsSync(from)).toBe(true);
  });

  test("skip leaves the source where it is", async () => {
    const { src, dest } = caseDirs();
    writeFileSync(join(src, "a.txt"), "new");
    writeFileSync(join(dest, "a.txt"), "old");
    const from = join(src, "a.txt");
    expect(
      await moveHostPaths([from], dest, new Map([[from, "skip"]])),
    ).toMatchObject({ results: [{ kind: "skipped", from }] });
    expect(readFileSync(from, "utf8")).toBe("new");
  });

  test("a missing source is reported, a missing or file destination refuses all", async () => {
    const { src, dest } = caseDirs();
    writeFileSync(join(src, "a.txt"), "A");
    const gone = join(src, "gone.txt");
    expect(await moveHostPaths([gone], dest, none)).toMatchObject({
      results: [{ kind: "missing", from: gone }],
    });
    expect(
      await moveHostPaths([join(src, "a.txt")], join(dest, "nope"), none),
    ).toEqual({ kind: "missing", path: join(dest, "nope") });
    expect(
      await moveHostPaths([join(src, "a.txt")], join(src, "a.txt"), none),
    ).toEqual({ kind: "not-a-dir", path: join(src, "a.txt") });
    expect(existsSync(join(src, "a.txt"))).toBe(true);
  });
});

describe("movePath", () => {
  test("across volumes (EXDEV) it copies, then removes the source", async () => {
    const { src, dest } = caseDirs();
    mkdirSync(join(src, "docs/sub"), { recursive: true });
    writeFileSync(join(src, "docs/sub/b.txt"), "B");
    const crossVolume = (): Promise<void> =>
      Promise.reject(
        Object.assign(new Error("cross-device link"), { code: "EXDEV" }),
      );
    await movePath(join(src, "docs"), join(dest, "docs"), crossVolume);
    expect(readdirSync(src)).toEqual([]);
    expect(readdirSync(dest)).toEqual(["docs"]);
    expect(readFileSync(join(dest, "docs/sub/b.txt"), "utf8")).toBe("B");
  });
});
