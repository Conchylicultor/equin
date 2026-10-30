import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FolderStatus } from "../../shared/status";
import { createFolderStatusStore, probeFolder } from "./folder-status";

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "midi-folder-status-")));
  mkdirSync(join(root, "ok"));
  writeFileSync(join(root, "file.mid"), "");
  mkdirSync(join(root, "locked"));
  chmodSync(join(root, "locked"), 0o000);
});

afterAll(() => {
  chmodSync(join(root, "locked"), 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("probeFolder", () => {
  test("a readable folder is ok, keyed by its real path", async () => {
    expect(await probeFolder(join(root, "ok"))).toEqual({
      state: "ok",
      path: join(root, "ok"),
      dir: join(root, "ok"),
    });
  });

  test("nothing at the path is missing", async () => {
    expect((await probeFolder(join(root, "gone"))).state).toBe("missing");
  });

  test("a component above the folder being a file is missing", async () => {
    expect((await probeFolder(join(root, "file.mid", "sub"))).state).toBe(
      "missing",
    );
  });

  test("a file is not a folder", async () => {
    expect((await probeFolder(join(root, "file.mid"))).state).toBe(
      "not-a-folder",
    );
  });

  // Root reads every folder whatever its mode, so the refusal only exists
  // for an ordinary user.
  test.skipIf(process.getuid?.() === 0)(
    "a folder the OS refuses to open is denied, with the errno",
    async () => {
      const status = await probeFolder(join(root, "locked"));
      expect(status.state).toBe("denied");
      if (status.state === "denied") expect(status.code).toBe("EACCES");
    },
  );
});

// A probe the test answers by hand — standing in for a resolve blocked on
// macOS's permission prompt.
function heldProbe() {
  const held = new Map<string, (s: FolderStatus) => void>();
  let calls = 0;
  return {
    probe: (path: string) => {
      calls += 1;
      return new Promise<FolderStatus>((resolve) => held.set(path, resolve));
    },
    answer: (path: string, status: FolderStatus) => held.get(path)?.(status),
    calls: () => calls,
  };
}

const ok = (path: string): FolderStatus => ({ state: "ok", path, dir: path });

describe("createFolderStatusStore", () => {
  test("answers within the bound, an unanswered folder reading checking", async () => {
    const p = heldProbe();
    const store = createFolderStatusStore({
      folders: () => ["/a", "/b"],
      probe: (path) =>
        path === "/a" ? Promise.resolve(ok("/a")) : p.probe(path),
      answerWithinMs: 20,
    });
    const statuses = await store.refresh();
    expect(statuses).toEqual([
      ok("/a"),
      { state: "checking", path: "/b", dir: "/b" },
    ]);
    // Only the answered folder is watched and walked.
    expect(store.readableDirs()).toEqual(["/a"]);
  });

  test("a late answer is published when it lands", async () => {
    const p = heldProbe();
    const store = createFolderStatusStore({
      folders: () => ["/b"],
      probe: p.probe,
      answerWithinMs: 10,
    });
    let changes = 0;
    store.onChange(() => (changes += 1));
    await store.refresh();
    expect(changes).toBe(1);
    const published = new Promise<void>((resolve) => store.onChange(resolve));
    p.answer("/b", ok("/b"));
    await published;
    expect(changes).toBe(2);
    expect(store.readableDirs()).toEqual(["/b"]);
    expect(await store.statuses()).toEqual([ok("/b")]);
  });

  test("a re-check joins the probe still waiting rather than starting another", async () => {
    const p = heldProbe();
    const store = createFolderStatusStore({
      folders: () => ["/b"],
      probe: p.probe,
      answerWithinMs: 5,
    });
    await store.refresh();
    await store.refresh();
    expect(p.calls()).toBe(1);
  });

  test("a folder that stops answering is no longer readable", async () => {
    let pending: ReturnType<typeof heldProbe> | null = null;
    const store = createFolderStatusStore({
      folders: () => ["/b"],
      probe: (path) =>
        pending === null ? Promise.resolve(ok(path)) : pending.probe(path),
      answerWithinMs: 5,
    });
    await store.refresh();
    expect(store.readableDirs()).toEqual(["/b"]);
    pending = heldProbe();
    await store.refresh();
    expect(store.readableDirs()).toEqual([]);
  });
});
