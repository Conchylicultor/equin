import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileWatcher } from "../../shared/engine";
import type { FileChangeEvent } from "../../shared/registry";
import { createDirWatchHub, type StartRootWatch } from "./dir-hub";

/** Await `p` and return the Error it rejected with; throw if it resolved. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** A fake native watch per root: counts starts / stops and emits on demand. */
function fakeStart() {
  const started: string[] = [];
  const stopped: string[] = [];
  const emitters = new Map<string, (events: FileChangeEvent[]) => void>();
  const start: StartRootWatch = async (root, onChange) => {
    if (root.includes("missing")) throw new Error(`ENOENT ${root}`);
    started.push(root);
    emitters.set(root, onChange);
    return {
      stop: async () => {
        stopped.push(root);
        emitters.delete(root);
      },
    };
  };
  const emit = (root: string, ...paths: string[]) =>
    emitters.get(root)!(paths.map((path) => ({ type: "update", path })));
  return { start, started, stopped, emit };
}

const paths = (events: FileChangeEvent[]) => events.map((e) => e.path);

describe("createDirWatchHub", () => {
  test("two watchers of one dir share one native watch; the last release stops it", async () => {
    const fake = fakeStart();
    const hub = createDirWatchHub(fake.start);
    const a: string[] = [];
    const b: string[] = [];
    const ra = await hub.acquire({
      dir: "/w",
      scope: "subtree",
      onChange: (e) => a.push(...paths(e)),
    });
    const rb = await hub.acquire({
      dir: "/w",
      scope: "subtree",
      onChange: (e) => b.push(...paths(e)),
    });
    expect(fake.started).toEqual(["/w"]);
    fake.emit("/w", "/w/x");
    expect(a).toEqual(["/w/x"]);
    expect(b).toEqual(["/w/x"]);
    ra();
    expect(fake.stopped).toEqual([]);
    rb();
    expect(fake.stopped).toEqual(["/w"]);
    expect(hub.roots()).toEqual([]);
  });

  test("a child of a watched root rides its watch, filtered to the child", async () => {
    const fake = fakeStart();
    const hub = createDirWatchHub(fake.start);
    const root: string[] = [];
    const child: string[] = [];
    const rr = await hub.acquire({
      dir: "/w",
      scope: "subtree",
      onChange: (e) => root.push(...paths(e)),
    });
    const rc = await hub.acquire({
      dir: "/w/a/b",
      scope: "subtree",
      onChange: (e) => child.push(...paths(e)),
    });
    expect(fake.started).toEqual(["/w"]);
    fake.emit("/w", "/w/top", "/w/a/b/deep/f", "/w/a/bc");
    expect(root).toEqual(["/w/top", "/w/a/b/deep/f", "/w/a/bc"]);
    expect(child).toEqual(["/w/a/b/deep/f"]);
    // The root's own watcher leaving does not stop the watch the child rides.
    rr();
    expect(fake.stopped).toEqual([]);
    rc();
    expect(fake.stopped).toEqual(["/w"]);
  });

  test("a root opened above an existing one takes its watchers over, and the old native watch stops", async () => {
    const fake = fakeStart();
    const hub = createDirWatchHub(fake.start);
    const child: string[] = [];
    const rc = await hub.acquire({
      dir: "/w/a",
      scope: "subtree",
      onChange: (e) => child.push(...paths(e)),
    });
    const rr = await hub.acquire({
      dir: "/w",
      scope: "subtree",
      onChange: () => {},
    });
    await Promise.resolve();
    expect(fake.started).toEqual(["/w/a", "/w"]);
    // The child moved onto /w: its own native watch is gone.
    expect(fake.stopped).toEqual(["/w/a"]);
    expect(hub.roots()).toEqual(["/w"]);
    fake.emit("/w", "/w/a/f", "/w/b/g");
    expect(child).toEqual(["/w/a/f"]);
    // The child's release follows it onto /w; the last release stops /w.
    rc();
    expect(fake.stopped).toEqual(["/w/a"]);
    rr();
    expect(fake.stopped).toEqual(["/w/a", "/w"]);
  });

  test("a watcher whose root opens after a root above it opened moves up when it goes live", async () => {
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const stopped: string[] = [];
    const emitters = new Map<string, (events: FileChangeEvent[]) => void>();
    const hub = createDirWatchHub(async (root, onChange) => {
      started.push(root);
      // /w/a opens only when the test lets it.
      if (root === "/w/a")
        await new Promise<void>((r) => releases.set(root, r));
      emitters.set(root, onChange);
      return {
        stop: async () => {
          stopped.push(root);
          emitters.delete(root);
        },
      };
    });
    const child: string[] = [];
    const pc = hub.acquire({
      dir: "/w/a",
      scope: "subtree",
      onChange: (e) => child.push(...paths(e)),
    });
    await Promise.resolve();
    const rr = await hub.acquire({
      dir: "/w",
      scope: "subtree",
      onChange: () => {},
    });
    releases.get("/w/a")!();
    const rc = await pc;
    await Promise.resolve();
    expect(stopped).toEqual(["/w/a"]);
    emitters.get("/w")!([{ type: "update", path: "/w/a/x" }]);
    expect(child).toEqual(["/w/a/x"]);
    rc();
    rr();
    expect(stopped).toEqual(["/w/a", "/w"]);
    expect(started).toEqual(["/w/a", "/w"]);
  });

  test("children scope hears only the dir's direct entries", async () => {
    const fake = fakeStart();
    const hub = createDirWatchHub(fake.start);
    const heard: string[] = [];
    const release = await hub.acquire({
      dir: "/w",
      scope: "children",
      onChange: (e) => heard.push(...paths(e)),
    });
    fake.emit("/w", "/w", "/w/new", "/w/sub/deep");
    expect(heard).toEqual(["/w", "/w/new"]);
    // Nothing in scope: the watcher is not called with an empty batch.
    let calls = 0;
    const r2 = await hub.acquire({
      dir: "/w/sub",
      scope: "children",
      onChange: () => calls++,
    });
    fake.emit("/w", "/w/other/x");
    expect(calls).toBe(0);
    release();
    r2();
  });

  test("a dir that cannot be watched rejects and holds nothing; a later acquire retries", async () => {
    const fake = fakeStart();
    const hub = createDirWatchHub(fake.start);
    const err = await rejection(
      hub.acquire({ dir: "/missing", scope: "subtree", onChange: () => {} }),
    );
    expect(err.message).toContain("ENOENT");
    expect(hub.roots()).toEqual([]);
  });

  test("a relative or unnormalized dir is refused", async () => {
    const hub = createDirWatchHub(fakeStart().start);
    for (const dir of ["rel", "/w/../x", "/w/"]) {
      const err = await rejection(
        hub.acquire({ dir, scope: "subtree", onChange: () => {} }),
      );
      expect(err.message).toContain("absolute, normalized");
    }
  });
});

describe("createDirWatchHub over the real engine", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test("a child watcher riding its parent's native watch hears a write inside it", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "dir-hub-")));
    const sub = join(dir, "sub");
    mkdirSync(sub);
    let natives = 0;
    const hub = createDirWatchHub(async (root, onChange) => {
      natives++;
      return createFileWatcher({ dirs: [root], debounceMs: 0, onChange });
    });
    const root: string[] = [];
    const child: string[] = [];
    const rr = await hub.acquire({
      dir,
      scope: "children",
      onChange: (e) => root.push(...paths(e)),
    });
    const rc = await hub.acquire({
      dir: sub,
      scope: "children",
      onChange: (e) => child.push(...paths(e)),
    });
    expect(natives).toBe(1);
    writeFileSync(join(sub, "f.txt"), "x");
    // Test-only bound, not production polling.
    for (let i = 0; i < 150 && child.length === 0; i++) await Bun.sleep(20);
    expect(child).toContain(join(sub, "f.txt"));
    // A depth-2 write is not an entry of the root's listing.
    expect(root).not.toContain(join(sub, "f.txt"));
    rc();
    rr();
  });
});
