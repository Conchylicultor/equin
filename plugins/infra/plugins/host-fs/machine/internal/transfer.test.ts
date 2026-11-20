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
import { join as joinPath } from "node:path";
import {
  asUserPath,
  type UserPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { compressHostPaths, copyHostPaths } from "./transfer";

/** A fixture path, branded as the request path it stands for. */
const join = (...parts: string[]): UserPath => asUserPath(joinPath(...parts));

let root: string;
let cases = 0;

/** A fresh, empty case folder (a real path: macOS's /tmp is a symlink). */
function caseDir(): UserPath {
  const dir = join(root, `case-${cases++}`);
  mkdirSync(dir);
  return dir;
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "host-fs-transfer-test-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("copyHostPaths", () => {
  test("copies files and folders into a folder, numbering a taken name", async () => {
    const dir = caseDir();
    const dest = join(dir, "dest");
    mkdirSync(dest);
    writeFileSync(join(dir, "a.txt"), "A");
    writeFileSync(join(dest, "a.txt"), "taken");
    mkdirSync(join(dir, "d"));
    writeFileSync(join(dir, "d", "f"), "F");
    const result = await copyHostPaths(
      [join(dir, "a.txt"), join(dir, "d"), join(dir, "gone")],
      dest,
    );
    expect(result).toEqual({
      kind: "ok",
      destDir: dest,
      results: [
        { kind: "copied", from: join(dir, "a.txt"), to: join(dest, "a 2.txt") },
        { kind: "copied", from: join(dir, "d"), to: join(dest, "d") },
        { kind: "missing", from: join(dir, "gone") },
      ],
    });
    expect(readFileSync(join(dest, "a 2.txt"), "utf8")).toBe("A");
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("taken");
    expect(readFileSync(join(dest, "d", "f"), "utf8")).toBe("F");
    // The sources stay, and no staging sibling is left behind.
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
    expect(readdirSync(dest).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("a paste into the source's own folder duplicates it", async () => {
    const dir = caseDir();
    writeFileSync(join(dir, "a.txt"), "A");
    const result = await copyHostPaths([join(dir, "a.txt")], dir);
    expect(result.kind === "ok" && result.results[0]).toEqual({
      kind: "copied",
      from: join(dir, "a.txt"),
      to: join(dir, "a 2.txt"),
    });
  });

  test("refuses a folder into itself, and a missing or file destination", async () => {
    const dir = caseDir();
    mkdirSync(join(dir, "d", "e"), { recursive: true });
    writeFileSync(join(dir, "f"), "");
    const into = await copyHostPaths([join(dir, "d")], join(dir, "d", "e"));
    expect(into.kind === "ok" && into.results[0]?.kind).toBe("into-self");
    expect(
      (await copyHostPaths([join(dir, "f")], join(dir, "nope"))).kind,
    ).toBe("missing");
    expect((await copyHostPaths([join(dir, "d")], join(dir, "f"))).kind).toBe(
      "not-a-dir",
    );
  });
});

describe("compressHostPaths", () => {
  test("one entry into <name>.zip, several into Archive.zip, numbered when taken", async () => {
    const dir = caseDir();
    writeFileSync(join(dir, "a.txt"), "A");
    mkdirSync(join(dir, "d"));
    writeFileSync(join(dir, "d", "f"), "F");
    expect(await compressHostPaths([join(dir, "a.txt")])).toEqual({
      kind: "compressed",
      path: join(dir, "a.txt.zip"),
    });
    expect(
      await compressHostPaths([join(dir, "a.txt"), join(dir, "d")]),
    ).toEqual({ kind: "compressed", path: join(dir, "Archive.zip") });
    expect(await compressHostPaths([join(dir, "d")])).toEqual({
      kind: "compressed",
      path: join(dir, "d.zip"),
    });
    expect(await compressHostPaths([join(dir, "d")])).toEqual({
      kind: "compressed",
      path: join(dir, "d 2.zip"),
    });
    // A zip's local file header starts with "PK\x03\x04".
    expect(readFileSync(join(dir, "Archive.zip")).subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
    expect(readdirSync(dir).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("refuses a missing entry and entries of two folders", async () => {
    const dir = caseDir();
    mkdirSync(join(dir, "d"));
    writeFileSync(join(dir, "a"), "");
    writeFileSync(join(dir, "d", "b"), "");
    expect((await compressHostPaths([join(dir, "nope")])).kind).toBe("missing");
    expect(
      (await compressHostPaths([join(dir, "a"), join(dir, "d", "b")])).kind,
    ).toBe("mixed-folders");
  });
});
