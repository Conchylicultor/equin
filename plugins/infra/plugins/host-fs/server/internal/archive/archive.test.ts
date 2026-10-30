import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHostPath } from "../list";
import { openHostPath } from "../open";
import { peekHostDir } from "../peek";
import { serveArchiveMember } from "../raw";
import { statHostOrArchivePath } from "../stat";
import { readHostPathText } from "../text";
import { locateHostPath } from "./locate";
import { defineArchiveFormat, type ArchiveMember } from "./registry";
import { normaliseMemberPath } from "./tree";
import {
  asUserPath,
  type UserPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// A fake format: a `.fake` file is JSON — `{ corrupt?: true, members: [...] }`,
// each file member's text held inline. Stored members are Blobs (sliceable),
// members named `*.stream` stream, so both raw paths are exercised.
interface FakeMember {
  path: string;
  kind: "file" | "dir" | "other";
  text?: string;
  encrypted?: boolean;
}

let indexCalls = 0;
const fakeFormat = defineArchiveFormat({
  id: "fake",
  claims: (name) => name.endsWith(".fake"),
  async index(file) {
    indexCalls++;
    const doc = JSON.parse(await readFile(file, "utf8")) as {
      corrupt?: boolean;
      members: FakeMember[];
    };
    if (doc.corrupt) return { kind: "unreadable", reason: "corrupt" };
    const members = doc.members.map((m): ArchiveMember => {
      if (m.kind !== "file")
        return { kind: m.kind, path: m.path, mtimeMs: 1000 };
      const bytes = new TextEncoder().encode(m.text ?? "");
      return {
        kind: "file",
        path: m.path,
        size: bytes.length,
        mtimeMs: 2000,
        open: async () => {
          if (m.encrypted) return { kind: "unreadable", reason: "encrypted" };
          if (m.path.endsWith(".stream")) {
            return {
              kind: "ok",
              size: bytes.length,
              body: new Blob([bytes]).stream(),
            };
          }
          return { kind: "ok", size: bytes.length, body: new Blob([bytes]) };
        },
      };
    });
    return { kind: "ok", members };
  },
});

let root: string;
let archive: UserPath;

function writeArchive(path: string, members: FakeMember[], corrupt = false) {
  writeFileSync(path, JSON.stringify({ corrupt, members }));
}

beforeAll(async () => {
  await fakeFormat.register();
  root = mkdtempSync(join(tmpdir(), "host-fs-archive-test-"));
  archive = asUserPath(join(root, "photos.fake"));
  writeArchive(archive, [
    { path: "readme.txt", kind: "file", text: "hello archive" },
    { path: "2022/summer/a.txt", kind: "file", text: "nested" },
    { path: "2022/b.stream", kind: "file", text: "0123456789" },
    { path: "empty/", kind: "dir" },
    { path: "../evil.txt", kind: "file", text: "escaped" },
    { path: "/abs/x.txt", kind: "file", text: "abs" },
    { path: "win\\path.txt", kind: "file", text: "backslash" },
    { path: "__MACOSX/._readme.txt", kind: "file", text: "fork" },
    { path: "secret.txt", kind: "file", text: "sealed", encrypted: true },
    { path: "link", kind: "other" },
  ]);
  writeArchive(join(root, "broken.fake"), [], true);
  mkdirSync(join(root, "real-dir.fake"));
  writeFileSync(join(root, "real-dir.fake", "inside.txt"), "disk");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("normaliseMemberPath", () => {
  test("reads backslashes, drops empty and dot segments, refuses ..", () => {
    expect(normaliseMemberPath("a/b/")).toBe("a/b");
    expect(normaliseMemberPath("/a/./b")).toBe("a/b");
    expect(normaliseMemberPath("a\\b")).toBe("a/b");
    expect(normaliseMemberPath("a/../b")).toBeNull();
  });
});

describe("locateHostPath", () => {
  test("a path on disk is a disk path, even under a claimed name", async () => {
    expect(await locateHostPath(asUserPath(archive))).toEqual({
      kind: "disk",
      path: archive,
    });
    const inside = asUserPath(join(root, "real-dir.fake", "inside.txt"));
    expect(await locateHostPath(inside)).toEqual({
      kind: "disk",
      path: inside,
    });
  });
  test("a path under an archive file is a member path", async () => {
    const located = await locateHostPath(
      asUserPath(join(archive, "2022", "summer", "a.txt")),
    );
    expect(located.kind).toBe("archive");
    if (located.kind !== "archive") return;
    expect(located.file).toBe(archive);
    expect(located.inner).toBe("2022/summer/a.txt");
  });
  test("a missing path no archive explains stays a disk path", async () => {
    const missing = asUserPath(join(root, "nope", "x.txt"));
    expect(await locateHostPath(missing)).toEqual({
      kind: "disk",
      path: missing,
    });
  });
});

describe("list", () => {
  test("a disk listing marks archive files", async () => {
    const res = await listHostPath(asUserPath(root));
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(byName["photos.fake"]!.archive).toEqual({ format: "fake" });
    expect(byName["photos.fake"]!.kind).toBe("file");
    expect(byName["real-dir.fake"]!.archive).toBeUndefined();
  });
  test("an archive file lists its root, with implied directories and no escapes", async () => {
    const res = await listHostPath(asUserPath(archive));
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.within).toEqual({ archive, format: "fake" });
    expect(res.parent).toBe(root);
    expect(res.entries.map((e) => e.name).sort()).toEqual([
      "2022",
      "__MACOSX",
      "abs",
      "empty",
      "link",
      "readme.txt",
      "secret.txt",
      "win",
    ]);
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(byName["2022"]!.kind).toBe("dir");
    expect(byName["__MACOSX"]!.hidden).toBe(true);
    expect(byName["link"]!.kind).toBe("other");
    expect(byName["readme.txt"]).toMatchObject({
      kind: "file",
      size: 13,
      mtimeMs: 2000,
    });
    // An archive records only mtime: no creation or access time.
    expect(byName["readme.txt"]!.birthtimeMs).toBeUndefined();
    expect(byName["readme.txt"]!.atimeMs).toBeUndefined();
  });
  test("a nested directory lists; a member file is not-a-dir; an unknown one missing", async () => {
    const nested = await listHostPath(asUserPath(join(archive, "2022")));
    if (nested.kind !== "ok")
      throw new Error(`expected ok, got ${nested.kind}`);
    expect(nested.entries.map((e) => e.name)).toEqual(["b.stream", "summer"]);
    expect(
      (await listHostPath(asUserPath(join(archive, "readme.txt")))).kind,
    ).toBe("not-a-dir");
    expect((await listHostPath(asUserPath(join(archive, "nope")))).kind).toBe(
      "missing",
    );
    const empty = await listHostPath(asUserPath(join(archive, "empty")));
    expect(empty.kind === "ok" && empty.entries).toEqual([]);
  });
  test("an unreadable archive is its own failure, never an empty folder", async () => {
    expect(await listHostPath(asUserPath(join(root, "broken.fake")))).toEqual({
      kind: "unreadable-archive",
      path: join(root, "broken.fake"),
      archive: join(root, "broken.fake"),
      reason: "corrupt",
    });
  });
});

describe("peek", () => {
  test("a folder inside an archive is read from the index; the archive file is never opened", async () => {
    expect(await peekHostDir(asUserPath(join(archive, "2022")))).toEqual({
      kind: "ok",
      path: join(archive, "2022"),
      children: [
        { name: "b.stream", hidden: false },
        { name: "summer", hidden: false },
      ],
    });
    const calls = indexCalls;
    expect(await peekHostDir(asUserPath(join(root, "broken.fake")))).toEqual({
      kind: "archive",
      path: join(root, "broken.fake"),
    });
    expect(indexCalls).toBe(calls);
  });
  test("a broken archive's member folder is unreadable, not empty", async () => {
    expect(
      (await peekHostDir(asUserPath(join(root, "broken.fake", "x")))).kind,
    ).toBe("unreadable-archive");
  });
  test("a real directory under a claimed name is read from disk", async () => {
    const real = await peekHostDir(asUserPath(join(root, "real-dir.fake")));
    expect(real.kind === "ok" && real.children).toEqual([
      { name: "inside.txt", hidden: false },
    ]);
  });
});

describe("stat / text", () => {
  test("stat describes a member and says it is within the archive", async () => {
    const res = await statHostOrArchivePath(
      asUserPath(join(archive, "2022", "summer")),
    );
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.entry).toMatchObject({ name: "summer", kind: "dir" });
    expect(res.within).toEqual({ archive, format: "fake" });
  });
  test("text reads a member, refuses a directory, types an encrypted one", async () => {
    expect(
      await readHostPathText(
        asUserPath(join(archive, "2022", "summer", "a.txt")),
      ),
    ).toMatchObject({
      kind: "ok",
      content: "nested",
      size: 6,
    });
    expect(
      (await readHostPathText(asUserPath(join(archive, "2022")))).kind,
    ).toBe("not-a-file");
    expect(
      await readHostPathText(asUserPath(join(archive, "secret.txt"))),
    ).toMatchObject({
      kind: "unreadable-archive",
      reason: "encrypted",
    });
  });
});

describe("raw", () => {
  const at = (inner: string) => ({
    kind: "archive" as const,
    file: archive,
    format: fakeFormat,
    inner,
  });
  test("a Blob member honours Range", async () => {
    const res = await serveArchiveMember(
      asUserPath(join(archive, "readme.txt")),
      at("readme.txt"),
      "bytes=0-4",
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/13");
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });
  test("a streamed member is served whole", async () => {
    const res = await serveArchiveMember(
      asUserPath(join(archive, "2022", "b.stream")),
      at("2022/b.stream"),
      "bytes=0-1",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("none");
    expect(await res.text()).toBe("0123456789");
  });
  test("failures map to statuses", async () => {
    expect(
      (await serveArchiveMember(asUserPath(join(archive, "x")), at("x"), null))
        .status,
    ).toBe(404);
    expect(
      (
        await serveArchiveMember(
          asUserPath(join(archive, "2022")),
          at("2022"),
          null,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await serveArchiveMember(
          asUserPath(join(archive, "secret.txt")),
          at("secret.txt"),
          null,
        )
      ).status,
    ).toBe(422);
  });
});

describe("open", () => {
  test("Open with default app on a member is in-archive", async () => {
    expect(
      await openHostPath(asUserPath(join(archive, "readme.txt")), false),
    ).toEqual({
      kind: "in-archive",
      path: join(archive, "readme.txt"),
      archive,
    });
  });
});

describe("index cache", () => {
  test("an unchanged archive is indexed once; a rewritten one again", async () => {
    const file = join(root, "cache.fake");
    writeArchive(file, [{ path: "one.txt", kind: "file", text: "1" }]);
    const before = indexCalls;
    await listHostPath(asUserPath(file));
    await listHostPath(asUserPath(file));
    expect(indexCalls).toBe(before + 1);
    writeArchive(file, [{ path: "two.txt", kind: "file", text: "22" }]);
    // Same-second rewrites can keep the mtime; a size change alone re-keys too,
    // but pin a later mtime so the test does not depend on it.
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const res = await listHostPath(asUserPath(file));
    expect(indexCalls).toBe(before + 2);
    expect(res.kind === "ok" && res.entries.map((e) => e.name)).toEqual([
      "two.txt",
    ]);
  });
});
