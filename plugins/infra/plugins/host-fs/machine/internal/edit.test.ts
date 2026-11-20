import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
  asUserPath,
  type UserPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  createHostEntry,
  deleteHostPaths,
  renameHostEntry,
  writeHostText,
} from "./edit";

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
  root = realpathSync(mkdtempSync(join(tmpdir(), "host-fs-edit-test-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("createHostEntry", () => {
  test("creates an empty file, then numbers the next one", async () => {
    const dir = caseDir();
    expect(await createHostEntry(dir, "untitled.txt", "file")).toEqual({
      kind: "created",
      path: join(dir, "untitled.txt"),
    });
    expect(await createHostEntry(dir, "untitled.txt", "file")).toEqual({
      kind: "created",
      path: join(dir, "untitled 2.txt"),
    });
    expect(readFileSync(join(dir, "untitled.txt"), "utf8")).toBe("");
  });

  test("creates a folder, numbered past a taken name", async () => {
    const dir = caseDir();
    mkdirSync(join(dir, "untitled folder"));
    expect(await createHostEntry(dir, "untitled folder", "dir")).toEqual({
      kind: "created",
      path: join(dir, "untitled folder 2"),
    });
    expect(statSync(join(dir, "untitled folder 2")).isDirectory()).toBe(true);
  });

  test("refuses a bad name, a missing folder and a file as the folder", async () => {
    const dir = caseDir();
    writeFileSync(join(dir, "f"), "x");
    expect((await createHostEntry(dir, "a/b", "file")).kind).toBe(
      "invalid-name",
    );
    expect((await createHostEntry(join(dir, "gone"), "a", "file")).kind).toBe(
      "missing",
    );
    expect((await createHostEntry(join(dir, "f"), "a", "file")).kind).toBe(
      "not-a-dir",
    );
  });
});

describe("renameHostEntry", () => {
  test("renames in place, never over another entry", async () => {
    const dir = caseDir();
    writeFileSync(join(dir, "a.txt"), "A");
    writeFileSync(join(dir, "b.txt"), "B");
    expect(await renameHostEntry(join(dir, "a.txt"), "b.txt")).toEqual({
      kind: "exists",
      from: join(dir, "a.txt"),
      to: join(dir, "b.txt"),
    });
    expect(await renameHostEntry(join(dir, "a.txt"), "c.txt")).toEqual({
      kind: "renamed",
      from: join(dir, "a.txt"),
      to: join(dir, "c.txt"),
    });
    expect(readFileSync(join(dir, "c.txt"), "utf8")).toBe("A");
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("B");
  });

  test("a missing entry and a bad name are refused", async () => {
    const dir = caseDir();
    expect((await renameHostEntry(join(dir, "nope"), "x")).kind).toBe(
      "missing",
    );
    writeFileSync(join(dir, "a"), "");
    expect((await renameHostEntry(join(dir, "a"), "..")).kind).toBe(
      "invalid-name",
    );
  });
});

describe("deleteHostPaths", () => {
  test("deletes files and folders, each with its own outcome", async () => {
    const dir = caseDir();
    writeFileSync(join(dir, "a.txt"), "A");
    mkdirSync(join(dir, "d", "e"), { recursive: true });
    writeFileSync(join(dir, "d", "e", "f"), "F");
    const result = await deleteHostPaths([
      join(dir, "a.txt"),
      join(dir, "d"),
      join(dir, "gone"),
    ]);
    expect(result.results.map((r) => r.kind)).toEqual([
      "removed",
      "removed",
      "missing",
    ]);
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
    expect(existsSync(join(dir, "d"))).toBe(false);
  });
});

describe("writeHostText", () => {
  test("saves text, keeping the file's permissions", async () => {
    const dir = caseDir();
    const file = join(dir, "a.sh");
    writeFileSync(file, "old");
    chmodSync(file, 0o755);
    expect(await writeHostText(file, "new ✓", "old")).toEqual({
      kind: "written",
      path: file,
      size: Buffer.byteLength("new ✓"),
    });
    expect(readFileSync(file, "utf8")).toBe("new ✓");
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  test("refuses when the file no longer holds the expected text", async () => {
    const dir = caseDir();
    const file = join(dir, "a.txt");
    writeFileSync(file, "changed meanwhile");
    expect((await writeHostText(file, "mine", "what I began from")).kind).toBe(
      "changed",
    );
    expect(readFileSync(file, "utf8")).toBe("changed meanwhile");
    // Without `expected`: an overwrite.
    expect((await writeHostText(file, "mine", undefined)).kind).toBe("written");
    expect(readFileSync(file, "utf8")).toBe("mine");
  });

  test("a missing file and a folder are refused", async () => {
    const dir = caseDir();
    expect((await writeHostText(join(dir, "nope"), "x", undefined)).kind).toBe(
      "missing",
    );
    expect((await writeHostText(dir, "x", undefined)).kind).toBe("not-a-file");
  });
});
