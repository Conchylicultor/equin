import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineArchiveFormat, type ArchiveMember } from "./archive/registry";
import { extractHostArchive } from "./extract";

// A fake format: a `.fakex` file is JSON — `{ members: [...] }`, each file
// member's text inline. An `encrypted` member fails to open.
interface FakeMember {
  path: string;
  kind: "file" | "dir";
  text?: string;
  encrypted?: boolean;
}

const fakeFormat = defineArchiveFormat({
  id: "fakex",
  claims: (name) => name.endsWith(".fakex"),
  async index(file) {
    const doc = JSON.parse(await readFile(file, "utf8")) as {
      members: FakeMember[];
    };
    const members = doc.members.map((m): ArchiveMember => {
      if (m.kind === "dir") return { kind: "dir", path: m.path, mtimeMs: 1000 };
      const bytes = new TextEncoder().encode(m.text ?? "");
      return {
        kind: "file",
        path: m.path,
        size: bytes.length,
        mtimeMs: 2000,
        open: async () =>
          m.encrypted
            ? { kind: "unreadable", reason: "encrypted" }
            : { kind: "ok", size: bytes.length, body: new Blob([bytes]) },
      };
    });
    return { kind: "ok", members };
  },
});

let root: string;
let cases = 0;

/** A fresh folder holding one archive named `name`. */
function archiveIn(name: string, members: FakeMember[]): string {
  const dir = join(root, `case-${cases++}`);
  mkdirSync(dir);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ members }));
  return path;
}

/** Everything beside the archive, the staging folder included were it left. */
const siblings = (path: string) => readdirSync(dirname(path)).sort();

beforeAll(async () => {
  await fakeFormat.register();
  root = mkdtempSync(join(tmpdir(), "host-fs-extract-test-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("extractHostArchive", () => {
  test("a single top-level folder is extracted as itself", async () => {
    const path = archiveIn("photos.fakex", [
      { path: "photos/a.txt", kind: "file", text: "A" },
      { path: "photos/sub/b.txt", kind: "file", text: "B" },
      { path: "__MACOSX/photos/._a.txt", kind: "file", text: "junk" },
    ]);
    expect(await extractHostArchive(path)).toEqual({
      kind: "extracted",
      path,
      created: join(dirname(path), "photos"),
      layout: "single",
    });
    expect(siblings(path)).toEqual(["photos", "photos.fakex"]);
    expect(readFileSync(join(dirname(path), "photos/sub/b.txt"), "utf8")).toBe(
      "B",
    );
  });

  test("a single top-level file is extracted beside the archive", async () => {
    const path = archiveIn("report.fakex", [
      { path: "report.pdf", kind: "file", text: "pdf" },
      { path: ".DS_Store", kind: "file", text: "junk" },
    ]);
    expect(await extractHostArchive(path)).toMatchObject({
      kind: "extracted",
      created: join(dirname(path), "report.pdf"),
      layout: "single",
    });
    expect(siblings(path)).toEqual(["report.fakex", "report.pdf"]);
  });

  test("several top-level entries go into a new folder", async () => {
    const path = archiveIn("bundle.fakex", [
      { path: "a.txt", kind: "file", text: "A" },
      { path: "docs/b.txt", kind: "file", text: "B" },
      { path: "empty", kind: "dir" },
    ]);
    expect(await extractHostArchive(path)).toMatchObject({
      kind: "extracted",
      created: join(dirname(path), "bundle"),
      layout: "folder",
    });
    expect(siblings(path)).toEqual(["bundle", "bundle.fakex"]);
    expect(readdirSync(join(dirname(path), "bundle")).sort()).toEqual([
      "a.txt",
      "docs",
      "empty",
    ]);
  });

  test("a taken name gets a number, nothing is overwritten", async () => {
    const path = archiveIn("notes.fakex", [
      { path: "notes.txt", kind: "file", text: "new" },
    ]);
    writeFileSync(join(dirname(path), "notes.txt"), "old");
    expect(await extractHostArchive(path)).toMatchObject({
      created: join(dirname(path), "notes 2.txt"),
    });
    expect(await extractHostArchive(path)).toMatchObject({
      created: join(dirname(path), "notes 3.txt"),
    });
    expect(readFileSync(join(dirname(path), "notes.txt"), "utf8")).toBe("old");
  });

  test("an unreadable member leaves nothing behind", async () => {
    const path = archiveIn("locked.fakex", [
      { path: "a.txt", kind: "file", text: "A" },
      { path: "b.txt", kind: "file", encrypted: true },
    ]);
    expect(await extractHostArchive(path)).toEqual({
      kind: "unreadable-archive",
      path,
      archive: path,
      reason: "encrypted",
    });
    expect(siblings(path)).toEqual(["locked.fakex"]);
  });

  test("a file no format claims is not an archive", async () => {
    const path = archiveIn("plain.txt", []);
    expect(await extractHostArchive(path)).toEqual({
      kind: "not-an-archive",
      path,
    });
  });

  test("a missing archive is missing", async () => {
    const path = join(root, "nowhere.fakex");
    expect(await extractHostArchive(path)).toEqual({ kind: "missing", path });
  });
});
