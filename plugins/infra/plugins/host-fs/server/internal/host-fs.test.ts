import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { completeHostDir, splitPrefix } from "./complete";
import { listHostDir } from "./list";
import { isAppOrigin, openArgv } from "./open";
import { peekHostDir } from "./peek";
import { classifyFsError, expandTilde, resolveHostPath } from "./path";
import { parseRange, serveHostFile } from "./raw";
import { statHostPath } from "./stat";
import { decodeTextBytes } from "./decode";
import { readHostText } from "./text";

// Fixture:
//   root/
//     .hidden-dir/
//     Alpha/
//     beta/  (contains file.txt)
//     notes.txt
//     link-to-beta -> beta          (symlink to a dir)
//     link-to-notes -> notes.txt    (symlink to a file)
//     dangling -> does-not-exist
//     locked/  (chmod 000)
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "host-fs-test-"));
  mkdirSync(join(root, ".hidden-dir"));
  mkdirSync(join(root, "Alpha"));
  mkdirSync(join(root, "beta"));
  writeFileSync(join(root, "beta", "file.txt"), "inside");
  writeFileSync(join(root, "notes.txt"), "hello");
  symlinkSync(join(root, "beta"), join(root, "link-to-beta"));
  symlinkSync("notes.txt", join(root, "link-to-notes"));
  symlinkSync(join(root, "does-not-exist"), join(root, "dangling"));
  mkdirSync(join(root, "locked"));
  chmodSync(join(root, "locked"), 0o000);
});

afterAll(() => {
  chmodSync(join(root, "locked"), 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("resolveHostPath", () => {
  test("expands ~ and ~/", () => {
    expect(expandTilde("~", "/home/u")).toBe("/home/u");
    expect(expandTilde("~/a/b", "/home/u")).toBe("/home/u/a/b");
    expect(expandTilde("/x/~/y", "/home/u")).toBe("/x/~/y");
    expect(resolveHostPath("~/docs/", "/home/u")).toBe("/home/u/docs");
  });
  test("defaults to home and normalises", () => {
    expect(resolveHostPath(undefined, "/home/u")).toBe("/home/u");
    expect(resolveHostPath("", "/home/u")).toBe("/home/u");
    expect(resolveHostPath("/a/./b/../c/", "/home/u")).toBe("/a/c");
  });
  test("rejects relative paths and NUL bytes with a 400", () => {
    expect(() => resolveHostPath("relative/x")).toThrow(HttpError);
    expect(() => resolveHostPath("/a\0b")).toThrow(HttpError);
  });
  test("classifyFsError rethrows the unexpected", () => {
    const weird = Object.assign(new Error("boom"), { code: "EIO" });
    expect(() => classifyFsError(weird)).toThrow("boom");
  });
});

describe("peek", () => {
  test("names every child with its hidden flag, without describing it", async () => {
    const res = await peekHostDir(root);
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    const children = Object.fromEntries(
      res.children.map((c) => [c.name, c.hidden]),
    );
    expect(children).toEqual({
      ".hidden-dir": true,
      Alpha: false,
      beta: false,
      "notes.txt": false,
      "link-to-beta": false,
      "link-to-notes": false,
      dangling: false,
      locked: false,
    });
  });
  test("reads a symlinked folder through the link", async () => {
    const res = await peekHostDir(join(root, "link-to-beta"));
    expect(res.kind === "ok" && res.children).toEqual([
      { name: "file.txt", hidden: false },
    ]);
  });
  test("denied, missing and not-a-dir are their own answers, never an empty folder", async () => {
    expect(
      await Promise.all(
        ["locked", "nope", "notes.txt", "Alpha"].map((name) =>
          peekHostDir(join(root, name)),
        ),
      ),
    ).toEqual([
      { kind: "denied", path: join(root, "locked") },
      { kind: "missing", path: join(root, "nope") },
      { kind: "not-a-dir", path: join(root, "notes.txt") },
      { kind: "ok", path: join(root, "Alpha"), children: [] },
    ]);
  });
});

describe("listHostDir", () => {
  test("lists every entry sorted by name, with kinds, hidden flags and symlink targets", async () => {
    const res = await listHostDir(root);
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.parent).toBe(join(root, ".."));
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(res.entries.map((e) => e.name)).toEqual([
      ".hidden-dir",
      "Alpha",
      "beta",
      "dangling",
      "link-to-beta",
      "link-to-notes",
      "locked",
      "notes.txt",
    ]);
    expect(byName[".hidden-dir"]).toMatchObject({ kind: "dir", hidden: true });
    expect(byName["notes.txt"]).toMatchObject({
      kind: "file",
      size: 5,
      hidden: false,
    });
    expect(byName["notes.txt"]!.symlinkTarget).toBeUndefined();
    // Creation and access times ride along from the same stat as mtime.
    expect(byName["notes.txt"]!.birthtimeMs).toBeGreaterThan(0);
    expect(byName["notes.txt"]!.atimeMs).toBeNumber();
    // A symlink to a directory IS a directory.
    expect(byName["link-to-beta"]).toMatchObject({
      kind: "dir",
      symlinkTarget: join(root, "beta"),
    });
    expect(byName["link-to-notes"]).toMatchObject({
      kind: "file",
      size: 5,
      symlinkTarget: "notes.txt",
    });
    expect(byName["dangling"]).toMatchObject({ kind: "symlink" });
    expect(byName["locked"]).toMatchObject({ kind: "dir" });
  });
  test("follows a symlink to a directory", async () => {
    const res = await listHostDir(join(root, "link-to-beta"));
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.entries.map((e) => e.name)).toEqual(["file.txt"]);
  });
  test("missing / not-a-dir / denied are typed, never an empty listing", async () => {
    expect(await listHostDir(join(root, "nope"))).toEqual({
      kind: "missing",
      path: join(root, "nope"),
    });
    expect(await listHostDir(join(root, "notes.txt", "x"))).toMatchObject({
      kind: "missing",
    });
    expect(await listHostDir(join(root, "notes.txt"))).toMatchObject({
      kind: "not-a-dir",
    });
    expect(await listHostDir(join(root, "dangling"))).toMatchObject({
      kind: "missing",
    });
    expect(await listHostDir(join(root, "locked"))).toEqual({
      kind: "denied",
      path: join(root, "locked"),
    });
  });
  test("the filesystem root has no parent", async () => {
    const res = await listHostDir("/");
    expect(res.kind === "ok" && res.parent).toBe(null);
  });
});

describe("statHostPath", () => {
  test("describes files, dirs and symlinks", async () => {
    expect(await statHostPath(join(root, "notes.txt"))).toMatchObject({
      kind: "ok",
      parent: root,
      entry: { name: "notes.txt", kind: "file", size: 5 },
    });
    expect(await statHostPath(join(root, "link-to-beta"))).toMatchObject({
      kind: "ok",
      entry: { kind: "dir", symlinkTarget: join(root, "beta") },
    });
    expect(await statHostPath(join(root, "dangling"))).toMatchObject({
      kind: "ok",
      entry: { kind: "symlink" },
    });
    expect(await statHostPath("/")).toMatchObject({
      kind: "ok",
      parent: null,
      entry: { name: "/", kind: "dir" },
    });
  });
  test("missing and denied", async () => {
    expect(await statHostPath(join(root, "nope"))).toMatchObject({
      kind: "missing",
    });
    expect(await statHostPath(join(root, "locked", "inside"))).toMatchObject({
      kind: "denied",
    });
  });
});

describe("complete", () => {
  test("splitPrefix", () => {
    expect(splitPrefix("~/Doc", "/home/u")).toEqual({
      dir: "/home/u",
      fragment: "Doc",
    });
    expect(splitPrefix("~", "/home/u")).toEqual({
      dir: "/home/u",
      fragment: "",
    });
    expect(splitPrefix("/usr/", "/home/u")).toEqual({
      dir: "/usr",
      fragment: "",
    });
    expect(splitPrefix("/", "/home/u")).toEqual({ dir: "/", fragment: "" });
    expect(() => splitPrefix("rel", "/home/u")).toThrow(HttpError);
    expect(() => splitPrefix("", "/home/u")).toThrow(HttpError);
  });
  test("folder-only, case-insensitive, symlinks to dirs included, hidden on request", async () => {
    const all = await completeHostDir(root, "");
    if (all.kind !== "ok") throw new Error(`expected ok, got ${all.kind}`);
    expect(all.matches.map((m) => m.name)).toEqual([
      "Alpha",
      "beta",
      "link-to-beta",
      "locked",
    ]);
    expect(all.matches[0]!.path).toBe(join(root, "Alpha"));
    expect(all.truncated).toBe(false);

    const a = await completeHostDir(root, "a");
    expect(a.kind === "ok" && a.matches.map((m) => m.name)).toEqual(["Alpha"]);
    const hidden = await completeHostDir(root, ".");
    expect(hidden.kind === "ok" && hidden.matches.map((m) => m.name)).toEqual([
      ".hidden-dir",
    ]);
  });
  test("caps the result", async () => {
    const res = await completeHostDir(root, "", 2);
    expect(res).toMatchObject({ kind: "ok", truncated: true });
    expect(res.kind === "ok" && res.matches.length).toBe(2);
  });
  test("typed failures for the searched directory", async () => {
    expect(await completeHostDir(join(root, "nope"), "")).toMatchObject({
      kind: "missing",
    });
    expect(await completeHostDir(join(root, "notes.txt"), "")).toMatchObject({
      kind: "not-a-dir",
    });
    expect(await completeHostDir(join(root, "locked"), "")).toMatchObject({
      kind: "denied",
    });
  });
});

describe("text", () => {
  test("decodeTextBytes gates size and sniffs NUL", () => {
    expect(decodeTextBytes(new TextEncoder().encode("héllo"))).toEqual({
      kind: "ok",
      content: "héllo",
    });
    expect(decodeTextBytes(new Uint8Array([104, 0, 105]))).toEqual({
      kind: "binary",
    });
    expect(decodeTextBytes(new Uint8Array(2 * 1024 * 1024 + 1))).toMatchObject({
      kind: "too-large",
    });
  });
  test("readHostText", async () => {
    expect(await readHostText(join(root, "notes.txt"))).toEqual({
      kind: "ok",
      path: join(root, "notes.txt"),
      content: "hello",
      size: 5,
    });
    expect(await readHostText(join(root, "beta"))).toMatchObject({
      kind: "not-a-file",
    });
    expect(await readHostText(join(root, "nope"))).toMatchObject({
      kind: "missing",
    });
  });
});

describe("raw", () => {
  test("parseRange", () => {
    expect(parseRange(null, 100)).toEqual({ kind: "none" });
    expect(parseRange("bytes=0-9", 100)).toEqual({
      kind: "range",
      range: { start: 0, end: 9 },
    });
    expect(parseRange("bytes=90-", 100)).toEqual({
      kind: "range",
      range: { start: 90, end: 99 },
    });
    expect(parseRange("bytes=90-500", 100)).toEqual({
      kind: "range",
      range: { start: 90, end: 99 },
    });
    expect(parseRange("bytes=-10", 100)).toEqual({
      kind: "range",
      range: { start: 90, end: 99 },
    });
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-1,5-6", 100)).toEqual({ kind: "none" });
    expect(parseRange("items=0-1", 100)).toEqual({ kind: "none" });
  });

  test("sandboxes every file but a PDF", async () => {
    writeFileSync(join(root, "page.html"), "<script></script>");
    writeFileSync(join(root, "doc.pdf"), "%PDF-1.4");
    const html = await serveHostFile(join(root, "page.html"), null);
    expect(html.headers.get("content-security-policy")).toBe("sandbox");
    const pdf = await serveHostFile(join(root, "doc.pdf"), null);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-security-policy")).toBeNull();
    expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("open", () => {
  test("only the app's own *.localhost origins", () => {
    expect(isAppOrigin("http://singularity.localhost:9000")).toBe(true);
    expect(isAppOrigin("http://sonata.att-1.localhost:9000")).toBe(true);
    expect(isAppOrigin("http://localhost:9000")).toBe(false);
    expect(isAppOrigin("https://evil.com")).toBe(false);
    expect(isAppOrigin("http://localhost.evil.com")).toBe(false);
    expect(isAppOrigin("null")).toBe(false);
    expect(isAppOrigin(null)).toBe(false);
  });
  test("argv never goes through a shell", () => {
    expect(openArgv("/a b/c;rm -rf", false)).toEqual(["open", "/a b/c;rm -rf"]);
    expect(openArgv("/x", true)).toEqual(["open", "-R", "/x"]);
  });
});
