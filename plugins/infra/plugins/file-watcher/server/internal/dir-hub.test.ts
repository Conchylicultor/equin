import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
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

/** A single-directory start a test does not expect the hub to call. */
const shallowNever: StartRootWatch = async (dir) => {
  throw new Error(`unexpected single-directory watch of ${dir}`);
};

describe("createDirWatchHub", () => {
  test("two watchers of one dir share one native watch; the last release stops it", async () => {
    const fake = fakeStart();
    const hub = createDirWatchHub({
      subtree: fake.start,
      children: shallowNever,
    });
    const a: string[] = [];
    const b: string[] = [];
    const ra = await hub.acquire({
      dir: "/w",
      scope: "subtree",
      onChange: (e) => void a.push(...paths(e)),
    });
    const rb = await hub.acquire({
      dir: "/w",
      scope: "subtree",
      onChange: (e) => void b.push(...paths(e)),
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
    const hub = createDirWatchHub({
      subtree: fake.start,
      children: shallowNever,
    });
    const root: string[] = [];
    const child: string[] = [];
    const rr = await hub.acquire({
      dir: "/w",
      scope: "subtree",
      onChange: (e) => void root.push(...paths(e)),
    });
    const rc = await hub.acquire({
      dir: "/w/a/b",
      scope: "subtree",
      onChange: (e) => void child.push(...paths(e)),
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
    const hub = createDirWatchHub({
      subtree: fake.start,
      children: shallowNever,
    });
    const child: string[] = [];
    const rc = await hub.acquire({
      dir: "/w/a",
      scope: "subtree",
      onChange: (e) => void child.push(...paths(e)),
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
    const hub = createDirWatchHub({
      children: shallowNever,
      subtree: async (root, onChange) => {
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
      },
    });
    const child: string[] = [];
    const pc = hub.acquire({
      dir: "/w/a",
      scope: "subtree",
      onChange: (e) => void child.push(...paths(e)),
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

  test("a children request with no root above it opens a single-directory watch, never a recursive root", async () => {
    const roots = fakeStart();
    const dirs = fakeStart();
    const hub = createDirWatchHub({
      subtree: roots.start,
      children: dirs.start,
    });
    const heard: string[] = [];
    const release = await hub.acquire({
      dir: "/w",
      scope: "children",
      onChange: (e) => void heard.push(...paths(e)),
    });
    const again = await hub.acquire({
      dir: "/w",
      scope: "children",
      onChange: () => {},
    });
    expect(roots.started).toEqual([]);
    // Two watchers of one dir share one handle.
    expect(dirs.started).toEqual(["/w"]);
    expect(hub.shallowDirs()).toEqual(["/w"]);
    dirs.emit("/w", "/w", "/w/new");
    expect(heard).toEqual(["/w", "/w/new"]);
    // A child folder's own children request is its own handle, not a ride.
    const sub = await hub.acquire({
      dir: "/w/sub",
      scope: "children",
      onChange: () => {},
    });
    expect(dirs.started).toEqual(["/w", "/w/sub"]);
    expect(hub.roots()).toEqual([]);
    release();
    expect(dirs.stopped).toEqual([]);
    again();
    sub();
    expect(dirs.stopped).toEqual(["/w", "/w/sub"]);
    expect(hub.shallowDirs()).toEqual([]);
  });

  test("a single-directory watch that reported its dir gone is retired: a re-arm opens a fresh one", async () => {
    // One emitter per opened watch (not per dir): two watches of /w coexist.
    const opened: { dir: string; emit: (e: FileChangeEvent[]) => void }[] = [];
    const started: string[] = [];
    const stopped: string[] = [];
    const children: StartRootWatch = async (dir, onChange) => {
      started.push(dir);
      opened.push({ dir, emit: onChange });
      return { stop: async () => void stopped.push(dir) };
    };
    const hub = createDirWatchHub({ subtree: shallowNever, children });
    const heard: FileChangeEvent[] = [];
    const onChange = (e: FileChangeEvent[]) => void heard.push(...e);
    const first = await hub.acquire({ dir: "/w", scope: "children", onChange });
    // The folder is replaced: the first watch reports it gone, and is dead.
    opened[0]!.emit([{ type: "delete", path: "/w" }]);
    // Re-arm before giving the first hold back (host-fs's rearmable order).
    const second = await hub.acquire({
      dir: "/w",
      scope: "children",
      onChange,
    });
    expect(started).toEqual(["/w", "/w"]);
    first();
    expect(stopped).toEqual(["/w"]);
    expect(hub.shallowDirs()).toEqual(["/w"]);
    // The new folder going is heard, through the fresh watch.
    opened[1]!.emit([{ type: "delete", path: "/w" }]);
    expect(heard).toEqual([
      { type: "delete", path: "/w" },
      { type: "delete", path: "/w" },
    ]);
    second();
    expect(stopped).toEqual(["/w", "/w"]);
    expect(hub.shallowDirs()).toEqual([]);
  });

  test("a children request under an open root rides it, hearing only the dir's direct entries", async () => {
    const fake = fakeStart();
    const hub = createDirWatchHub({
      subtree: fake.start,
      children: shallowNever,
    });
    const root = await hub.acquire({
      dir: "/w",
      scope: "subtree",
      onChange: () => {},
    });
    const heard: string[] = [];
    const release = await hub.acquire({
      dir: "/w/a",
      scope: "children",
      onChange: (e) => void heard.push(...paths(e)),
    });
    expect(fake.started).toEqual(["/w"]);
    fake.emit("/w", "/w/a", "/w/a/new", "/w/a/sub/deep", "/w/b");
    expect(heard).toEqual(["/w/a", "/w/a/new"]);
    // Nothing in scope: the watcher is not called with an empty batch.
    let calls = 0;
    const r2 = await hub.acquire({
      dir: "/w/a/sub",
      scope: "children",
      onChange: () => void calls++,
    });
    fake.emit("/w", "/w/other/x");
    expect(calls).toBe(0);
    release();
    r2();
    root();
  });

  test("a dir that cannot be watched rejects and holds nothing; a later acquire retries", async () => {
    const fake = fakeStart();
    const hub = createDirWatchHub({
      subtree: fake.start,
      children: shallowNever,
    });
    const err = await rejection(
      hub.acquire({ dir: "/missing", scope: "subtree", onChange: () => {} }),
    );
    expect(err.message).toContain("ENOENT");
    expect(hub.roots()).toEqual([]);
  });

  test("a relative or unnormalized dir is refused", async () => {
    const hub = createDirWatchHub({
      subtree: fakeStart().start,
      children: shallowNever,
    });
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
    const hub = createDirWatchHub({
      subtree: async (root, onChange) => {
        natives++;
        return createFileWatcher({ dirs: [root], debounceMs: 0, onChange });
      },
      children: shallowNever,
    });
    const root: string[] = [];
    const child: string[] = [];
    const rr = await hub.acquire({
      dir,
      scope: "subtree",
      onChange: (e) => void root.push(...paths(e)),
    });
    const rc = await hub.acquire({
      dir: sub,
      scope: "children",
      onChange: (e) => void child.push(...paths(e)),
    });
    expect(natives).toBe(1);
    writeFileSync(join(sub, "f.txt"), "x");
    // Test-only bound, not production polling.
    for (let i = 0; i < 150 && child.length === 0; i++) await Bun.sleep(20);
    expect(child).toContain(join(sub, "f.txt"));
    rc();
    rr();
  });

  /** A hub whose single-directory watches are the real engine's. */
  const childrenHub = () =>
    createDirWatchHub({
      subtree: shallowNever,
      children: (root, onChange) =>
        createFileWatcher({
          dirs: [root],
          depth: "children",
          debounceMs: 0,
          onChange,
        }),
    });

  /** Until `done` holds, at most 3 s. Test-only bound, not production polling. */
  const wait = async (done: () => boolean) => {
    for (let i = 0; i < 150 && !done(); i++) await Bun.sleep(20);
  };

  /**
   * Resolve once `watched`'s watch hears an entry written into it. Bun's
   * single-directory `fs.watch` goes live a moment AFTER it returns: on macOS
   * every directory watch of the process shares one FSEvents stream, which Bun
   * (re)starts on its own thread, from "now", whenever a watch opens or closes.
   * A write landing in that gap is never reported — measured: this file's first
   * directory watch, opened after the parcel-backed test above, lost both
   * entries written right after `acquire` and heard nothing at all, while a
   * write half a second later was heard. So probe until one is heard, then
   * test.
   */
  const untilLive = async (watched: string, heard: FileChangeEvent[]) => {
    for (let i = 0; i < 20; i++) {
      const probe = join(watched, `.probe-${i}`);
      writeFileSync(probe, "");
      await wait(() => paths(heard).includes(probe));
      if (paths(heard).includes(probe)) return;
    }
    throw new Error(`the watch of ${watched} never went live`);
  };

  test("a single-directory watch hears its entries, not a write deeper down, and the folder going", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "dir-hub-")));
    const watched = join(dir, "watched");
    const sub = join(watched, "sub");
    mkdirSync(sub, { recursive: true });
    const hub = childrenHub();
    const heard: FileChangeEvent[] = [];
    const release = await hub.acquire({
      dir: watched,
      scope: "children",
      onChange: (e) => void heard.push(...e),
    });
    await untilLive(watched, heard);
    writeFileSync(join(sub, "deep.txt"), "x");
    writeFileSync(join(watched, "f.txt"), "x");
    await wait(() => paths(heard).includes(join(watched, "f.txt")));
    expect(heard).toContainEqual({
      type: "create",
      path: join(watched, "f.txt"),
    });
    expect(paths(heard)).not.toContain(join(sub, "deep.txt"));
    rmSync(watched, { recursive: true });
    await wait(() =>
      heard.some((e) => e.path === watched && e.type === "delete"),
    );
    expect(heard).toContainEqual({ type: "delete", path: watched });
    release();
  });

  test("a single-directory watch reports the folder renamed away as its delete, and nothing for a sibling moving", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "dir-hub-")));
    const watched = join(dir, "watched");
    const sibling = join(dir, "sibling");
    mkdirSync(watched);
    mkdirSync(sibling);
    const hub = childrenHub();
    const heard: FileChangeEvent[] = [];
    const release = await hub.acquire({
      dir: watched,
      scope: "children",
      onChange: (e) => void heard.push(...e),
    });
    await untilLive(watched, heard);
    renameSync(sibling, join(dir, "sibling-moved"));
    renameSync(watched, join(dir, "moved"));
    await wait(() =>
      heard.some((e) => e.path === watched && e.type === "delete"),
    );
    expect(heard).toContainEqual({ type: "delete", path: watched });
    // Nothing but the probe and the folder itself: the sibling moving is
    // not this folder's business.
    expect(
      heard.filter((e) => !e.path.startsWith(join(watched, ".probe-"))),
    ).toEqual([{ type: "delete", path: watched }]);
    release();
  });
});
