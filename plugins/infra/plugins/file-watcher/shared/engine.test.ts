import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWatcher,
  fsEventsStreams,
  parcelBatchHandler,
  WatchedDirGoneError,
  type FileWatcher,
  type FileWatcherOptions,
} from "./engine";
import { followedDirs } from "./follow-files";
import {
  KQUEUE_CHILDREN_CAP,
  KQUEUE_CHILDREN_OPEN_BUDGET,
  kqueueChildrenReserved,
} from "./kqueue-children";
import type { FileChangeEvent } from "./registry";

let dir: string | null = null;
let staging: string | null = null;
let watcher: FileWatcher | null = null;
let writer: Bun.Subprocess | null = null;

afterEach(async () => {
  writer?.kill("SIGKILL");
  await writer?.exited;
  writer = null;
  await watcher?.stop();
  watcher = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
  if (staging !== null) rmSync(staging, { recursive: true, force: true });
  staging = null;
});

describe("createFileWatcher: writesWhileOpen follows named files", () => {
  test("reports appends to a file another process still holds open", async () => {
    // macOS FSEvents (the default backend there) reports this file's change
    // only when the writer closes its descriptor. The writer below keeps it
    // open past the test, so three events can only come from per-write reports.
    dir = mkdtempSync(join(tmpdir(), "fw-open-"));
    const file = join(dir, "held.log");
    writeFileSync(file, "");
    let events = 0;
    watcher = await createFileWatcher({
      files: [file],
      writesWhileOpen: true,
      debounceMs: 0,
      onChange: (batch) => {
        events += batch.filter((e) => e.type === "update").length;
      },
    });
    // The open hands one `update` for a file already there (a write may have
    // landed before the follow existed): count from after it.
    await until(() => events >= 1);
    events = 0;
    writer = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        'exec 3>>"$F"; for i in 1 2 3; do echo l$i >&3; sleep 0.4; done; sleep 45',
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, F: file },
      },
    );
    // Test-only bound, not production polling.
    for (let i = 0; i < 150 && events < 3; i++) await Bun.sleep(20);
    expect(events).toBeGreaterThanOrEqual(3);
    expect(writer.exitCode).toBeNull();
  });

  test("holds a descriptor per named file, not per entry of its dir", async () => {
    if (process.platform !== "darwin") return; // kqueue's cost model
    dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-bounded-")));
    for (let i = 0; i < 300; i++) writeFileSync(join(dir, `other${i}`), "");
    const file = join(dir, "followed.log");
    writeFileSync(file, "");
    const heard: string[] = [];
    watcher = await createFileWatcher({
      files: [file],
      writesWhileOpen: true,
      debounceMs: 0,
      onChange: (batch) => void heard.push(...batch.map((e) => e.path)),
    });
    // The dir and the one file.
    expect(descriptorsUnder(dir)).toBe(2);
    appendFileSync(join(dir, "other1"), "x");
    appendFileSync(file, "x");
    await until(() => heard.filter((p) => p === file).length >= 2);
    expect(heard.filter((p) => p !== file)).toEqual([]);
    // Deleting what it does not follow costs nothing (parcel's kqueue leaks the
    // descriptor of a WATCHED file that is deleted; these never had one).
    for (let i = 0; i < 300; i++) rmSync(join(dir, `other${i}`));
    await Bun.sleep(200);
    expect(descriptorsUnder(dir)).toBe(2);
    await watcher.stop();
    watcher = null;
    expect(descriptorsUnder(dir)).toBe(0);
  });

  test("hears a named file from its creation", async () => {
    dir = mkdtempSync(join(tmpdir(), "fw-later-"));
    const file = join(dir, "later.log");
    const heard: string[] = [];
    watcher = await createFileWatcher({
      files: [file],
      writesWhileOpen: true,
      debounceMs: 0,
      onChange: (batch) => void heard.push(...batch.map((e) => `${e.type}`)),
    });
    writeFileSync(file, "a\n");
    await until(() => heard.includes("create"));
    appendFileSync(file, "b\n");
    await until(() => heard.includes("update"));
    expect(heard).toContain("create");
    expect(heard).toContain("update");
  });

  test("the re-read an open hands over is not timed as a delivery", async () => {
    // The open's `update` is made up (nothing was heard): timing it read the
    // file's age as lag — main's daemon.pid-files follow recorded 13.7 h.
    dir = mkdtempSync(join(tmpdir(), "fw-lag-"));
    const file = join(dir, "old.log");
    writeFileSync(file, "");
    await Bun.sleep(1_500);
    const lags: number[] = [];
    let updates = 0;
    watcher = await createFileWatcher({
      files: [file],
      writesWhileOpen: true,
      debounceMs: 0,
      onDeliveryLag: (s) => void lags.push(s.lagMs),
      onChange: (batch) => {
        updates += batch.filter((e) => e.type === "update").length;
      },
    });
    await until(() => updates >= 1);
    expect(updates).toBe(1);
    await Bun.sleep(200); // the probe stats asynchronously
    // Timed, it would read ~1.5 s: the file's age.
    expect(lags).toEqual([]);
  });

  test("two follows of one dir share it, and each hears only its files", async () => {
    // parcel caches a dir's listing per path: a second subscription with a
    // different ignore fails outright. One subscription per dir carries both.
    dir = mkdtempSync(join(tmpdir(), "fw-shared-"));
    const a = join(dir, "a.log");
    const b = join(dir, "b.log");
    writeFileSync(a, "");
    writeFileSync(b, "");
    const heardA: string[] = [];
    const heardB: string[] = [];
    watcher = await createFileWatcher({
      files: [a],
      writesWhileOpen: true,
      debounceMs: 0,
      onChange: (batch) => void heardA.push(...batch.map((e) => e.path)),
    });
    const second = await createFileWatcher({
      files: [b],
      writesWhileOpen: true,
      debounceMs: 0,
      onChange: (batch) => void heardB.push(...batch.map((e) => e.path)),
    });
    try {
      heardA.length = 0;
      heardB.length = 0;
      appendFileSync(a, "x");
      appendFileSync(b, "y");
      await until(() => heardA.includes(a) && heardB.includes(b));
      expect(heardA.every((p) => p === a)).toBe(true);
      expect(heardB.every((p) => p === b)).toBe(true);
      expect(heardA).toContain(a);
      expect(heardB).toContain(b);
    } finally {
      await second.stop();
    }
    // The first still hears after the second left (its subscription re-opened).
    heardA.length = 0;
    appendFileSync(a, "z");
    await until(() => heardA.includes(a));
    expect(heardA).toContain(a);
  });

  test("a missing dir rejects the follow and holds nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "fw-missing-"));
    let error: unknown = null;
    try {
      watcher = await createFileWatcher({
        files: [join(dir, "nope", "x.log")],
        writesWhileOpen: true,
        onChange: () => {},
      });
    } catch (err) {
      error = err;
    }
    expect(error).not.toBeNull();
    expect(followedDirs()).toEqual([]);
  });

  test("a followed name that loops (ELOOP) does not leave its dir unfollowable", async () => {
    // kqueue lists a looping symlink without a descriptor, so the open
    // succeeds; the re-read it hands over then asked for the name THROUGH the
    // link (`access`: ELOOP), the reopen rejected, and every later follow of
    // the dir in the process failed with it (2026-11-12: the supervised runs
    // dir, so no run streamed its output live). The re-read asks for the
    // entry, and a failed reopen never blocks the next one.
    if (process.platform !== "darwin") return; // kqueue's handling of the link
    dir = mkdtempSync(join(tmpdir(), "fw-loop-"));
    const loop = join(dir, "loop.log");
    symlinkSync(loop, loop);
    const ok = join(dir, "ok.log");
    writeFileSync(ok, "");
    const looped: string[] = [];
    watcher = await createFileWatcher({
      files: [loop],
      writesWhileOpen: true,
      debounceMs: 0,
      onChange: (batch) => void looped.push(...batch.map((e) => e.path)),
    });
    // The link is an entry: its follower is handed the re-read, to fail itself.
    await until(() => looped.includes(loop));
    expect(looped).toContain(loop);
    const heard: string[] = [];
    const second = await createFileWatcher({
      files: [ok],
      writesWhileOpen: true,
      debounceMs: 0,
      onChange: (batch) => void heard.push(...batch.map((e) => e.type)),
    });
    try {
      await until(() => heard.includes("update"));
      heard.length = 0;
      appendFileSync(ok, "x");
      await until(() => heard.includes("update"));
      expect(heard).toContain("update");
    } finally {
      await second.stop();
    }
  });

  test("a directory has no spelling", () => {
    const opts: FileWatcherOptions = {
      // @ts-expect-error — a writesWhileOpen watch takes files, never dirs
      dirs: ["/tmp"],
      writesWhileOpen: true,
      onChange: () => {},
    };
    expect(opts).toBeDefined();
  });
});

/** How many descriptors this process holds on paths under `root`. */
function descriptorsUnder(root: string): number {
  const out = Bun.spawnSync(["lsof", "-p", String(process.pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return out.stdout
    .toString()
    .split("\n")
    .filter((l) => l.includes(root)).length;
}

// Test-only bound, not production polling.
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 150 && !done(); i++) await Bun.sleep(20);
}

/**
 * A folder that appears in the watched dir with its entries already inside —
 * what a backend that watches each directory on its own sees when its thread
 * gets to a new folder after something was written in it (2026-10-31: an SDK
 * agent's events file went unheard for its lifetime). Built outside the watch,
 * then moved in, so the race is certain, not timing-dependent.
 */
function moveInFolder(root: string, files: Record<string, string>): string {
  staging = mkdtempSync(join(tmpdir(), "fw-staging-"));
  for (const [rel, text] of Object.entries(files)) {
    const path = join(staging, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  const target = join(root, "moved");
  renameSync(staging, target);
  staging = null;
  return target;
}

describe("createFileWatcher: a folder that arrives with entries inside", () => {
  // inotify (Linux) watches each directory on its own (`new-dirs.ts`). A dir
  // watch on darwin is FSEvents, which reports by path and needs none of it.
  test("reports what it held, and hears every later write to it", async () => {
    if (process.platform !== "linux") return;
    dir = mkdtempSync(join(tmpdir(), "fw-moved-"));
    const heard: string[] = [];
    watcher = await createFileWatcher({
      dirs: [dir],
      debounceMs: 0,
      onChange: (batch) => {
        for (const e of batch) heard.push(`${e.type} ${e.path}`);
      },
    });
    const moved = moveInFolder(dir, {
      "events.jsonl": "1\n",
      "deep/inner.log": "a\n",
    });
    const file = join(moved, "events.jsonl");
    const inner = join(moved, "deep", "inner.log");
    await until(() => heard.includes(`create ${file}`));
    expect(heard).toContain(`create ${file}`);
    expect(heard).toContain(`create ${inner}`);

    for (const line of ["2", "3"]) {
      appendFileSync(file, `${line}\n`);
      appendFileSync(inner, `${line}\n`);
      await Bun.sleep(100);
    }
    await until(
      () =>
        heard.includes(`update ${file}`) && heard.includes(`update ${inner}`),
    );
    expect(heard).toContain(`update ${file}`);
    expect(heard).toContain(`update ${inner}`);
  });

  test("leaves out what the watcher ignores", async () => {
    if (process.platform !== "linux") return;
    dir = mkdtempSync(join(tmpdir(), "fw-moved-ignore-"));
    const heard: string[] = [];
    watcher = await createFileWatcher({
      dirs: [dir],
      ignore: ["**/skip/**"],
      debounceMs: 0,
      onChange: (batch) => {
        for (const e of batch) heard.push(e.path);
      },
    });
    const moved = moveInFolder(dir, {
      "kept.txt": "x",
      "skip/dropped.txt": "x",
    });
    await until(() => heard.includes(join(moved, "kept.txt")));
    expect(heard).toContain(join(moved, "kept.txt"));
    expect(heard.filter((p) => p.includes("/skip"))).toEqual([]);
  });
});

describe("createFileWatcher: a watched dir that goes", () => {
  test("its watch closes and says so, and every other watch keeps hearing", async () => {
    // A parcel subscription whose root is gone deafens every other parcel
    // subscription in the process for as long as it stays open — the
    // 2026-11-02 load-flaky DataFiles watch test, run after a dir-hub test
    // that failed holding one. So the engine closes it the moment it goes.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-gone-")));
    const doomed = join(dir, "doomed");
    const other = join(dir, "other");
    mkdirSync(doomed);
    mkdirSync(other);
    const lost: unknown[] = [];
    watcher = await createFileWatcher({
      dirs: [doomed],
      debounceMs: 0,
      onChange: () => {},
      onLost: (_dir, error) => void lost.push(error),
    });
    rmSync(doomed, { recursive: true });
    await until(() => lost.length > 0);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeInstanceOf(WatchedDirGoneError);
    expect(watcher.losses()).toBe(1);

    const heard: string[] = [];
    const after = await createFileWatcher({
      dirs: [other],
      debounceMs: 0,
      onChange: (batch) => void heard.push(...batch.map((e) => e.path)),
    });
    try {
      writeFileSync(join(other, "f.txt"), "x");
      await until(() => heard.includes(join(other, "f.txt")));
      expect(heard).toContain(join(other, "f.txt"));
    } finally {
      await after.stop();
    }
  });
});

describe("createFileWatcher: depth children", () => {
  const childrenWatch = (
    of: string,
    heard: FileChangeEvent[],
  ): Promise<FileWatcher> =>
    createFileWatcher({
      dirs: [of],
      depth: "children",
      debounceMs: 0,
      onChange: (batch) => void heard.push(...batch),
    });

  test("is live when it resolves: a write right after start is heard", async () => {
    // Each round a fresh watch, written to at once — the arm-then-read shape
    // (the daemon's pid-file holder). Bun's fs.watch went live a moment after
    // it returned and lost such writes.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-children-")));
    for (let i = 0; i < 10; i++) {
      const watched = join(dir, `w${i}`);
      mkdirSync(watched);
      const heard: FileChangeEvent[] = [];
      const w = await childrenWatch(watched, heard);
      try {
        const file = join(watched, "pid");
        writeFileSync(file, "x");
        await until(() => heard.some((e) => e.path === file));
        expect(heard.map((e) => e.path)).toContain(file);
      } finally {
        await w.stop();
      }
    }
  });

  test("hears every write while other directory watches open and close", async () => {
    // Bun's directory watches shared one FSEvents stream, restarted from
    // "now" on every open or close: 72 of 300 writes were missed under churn.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-children-")));
    const watched = join(dir, "watched");
    const other = join(dir, "other");
    mkdirSync(watched);
    mkdirSync(other);
    const heard: FileChangeEvent[] = [];
    watcher = await childrenWatch(watched, heard);
    const written: string[] = [];
    for (let i = 0; i < 50; i++) {
      const churn = await childrenWatch(other, []);
      const file = join(watched, `f${i}`);
      writeFileSync(file, "x");
      written.push(file);
      await churn.stop();
    }
    const missing = () =>
      written.filter((f) => !heard.some((e) => e.path === f));
    await until(() => missing().length === 0);
    expect(missing()).toEqual([]);
  });

  test("a dir reached through a symlink: entries named under it, nothing deeper", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-children-")));
    const real = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(join(real, "sub"), { recursive: true });
    symlinkSync(real, link);
    const heard: FileChangeEvent[] = [];
    watcher = await childrenWatch(link, heard);
    writeFileSync(join(real, "sub", "deep.txt"), "x");
    writeFileSync(join(real, "f.txt"), "x");
    await until(() => heard.some((e) => e.path === join(link, "f.txt")));
    expect(heard.map((e) => e.path)).toContain(join(link, "f.txt"));
    expect(heard.every((e) => e.path.startsWith(`${link}/`))).toBe(true);
  });

  test("hears its entries only, and the folder going as one delete of it", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-children-")));
    const watched = join(dir, "watched");
    const sub = join(watched, "sub");
    mkdirSync(sub, { recursive: true });
    const heard: FileChangeEvent[] = [];
    watcher = await childrenWatch(watched, heard);
    writeFileSync(join(sub, "deep.txt"), "x");
    writeFileSync(join(watched, "f.txt"), "x");
    await until(() => heard.some((e) => e.path === join(watched, "f.txt")));
    expect(heard.map((e) => e.path)).not.toContain(join(sub, "deep.txt"));
    rmSync(watched, { recursive: true });
    await until(() => heard.some((e) => e.path === watched));
    expect(heard.filter((e) => e.path === watched)).toEqual([
      { type: "delete", path: watched },
    ]);
  });
});

describe("createFileWatcher: drained()", () => {
  test("hands a batch still in its debounce window over now, and waits for its run", async () => {
    // A followed file (kqueue on darwin): its open hands an `update` for the
    // file at once, which then sits in the debounce window.
    dir = mkdtempSync(join(tmpdir(), "fw-drained-"));
    const file = join(dir, "f.log");
    writeFileSync(file, "");
    const heard: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let runs = 0;
    watcher = await createFileWatcher({
      files: [file],
      writesWhileOpen: true,
      // A window far longer than the test: only drained() hands it over.
      debounceMs: 60_000,
      ceilingMs: 60_000,
      onChange: async (batch) => {
        heard.push(...batch.map((e) => e.path));
        runs += 1;
        await held;
      },
    });
    expect(watcher.losses()).toBe(0);
    // However long the open's event takes to reach the engine, the drained()
    // after it hands it to onChange at once.
    let last = { done: false, promise: Promise.resolve() };
    for (let i = 0; i < 250 && heard.length === 0; i++) {
      const call = { done: false, promise: Promise.resolve() };
      call.promise = watcher.drained().then(() => {
        call.done = true;
      });
      last = call;
      await Bun.sleep(20);
    }
    expect(heard.map((p) => realpathSync(p))).toEqual([realpathSync(file)]);
    // The call that handed it over waits for its run, which has not settled.
    await Bun.sleep(50);
    expect(last.done).toBe(false);
    release();
    await last.promise;
    expect(runs).toBe(1);
    // Nothing received since: at once.
    await watcher.drained();
    expect(runs).toBe(1);
  }, 15_000);
});

describe("createFileWatcher: a followed file's dir that goes", () => {
  test("the follow closes and says so", async () => {
    // The same poison as a dir watch's: the dir's subscription must close
    // when the dir goes, whatever its ignore lets through.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-follow-gone-")));
    const doomed = join(dir, "doomed");
    mkdirSync(doomed);
    const file = join(doomed, "events.jsonl");
    writeFileSync(file, "");
    const lost: unknown[] = [];
    watcher = await createFileWatcher({
      files: [file],
      writesWhileOpen: true,
      debounceMs: 0,
      onChange: () => {},
      onLost: (_dir, error) => void lost.push(error),
    });
    rmSync(doomed, { recursive: true });
    await until(() => lost.length > 0);
    expect(lost[0]).toBeInstanceOf(WatchedDirGoneError);
    await watcher.stop();
    watcher = null;
    expect(followedDirs()).toEqual([]);
  });

  test("a stopped follow hears nothing more", async () => {
    dir = mkdtempSync(join(tmpdir(), "fw-stopped-"));
    const file = join(dir, "a.log");
    writeFileSync(file, "");
    let calls = 0;
    const follow = await createFileWatcher({
      files: [file],
      writesWhileOpen: true,
      debounceMs: 0,
      onChange: () => {
        calls += 1;
      },
    });
    await follow.stop();
    calls = 0;
    appendFileSync(file, "x");
    await Bun.sleep(300);
    expect(calls).toBe(0);
  });
});

describe("parcelBatchHandler", () => {
  test("an error batch still delivers its events, then reports the loss", () => {
    const order: string[] = [];
    const handler = parcelBatchHandler(
      (events) => order.push(...events.map((e) => `take:${e.path}`)),
      (error) => order.push(`lost:${error.message}`),
    );
    handler(new Error("Events were dropped by the FSEvents client"), [
      { type: "update", path: "/d/a" },
    ]);
    handler(null, [{ type: "create", path: "/d/b" }]);
    expect(order).toEqual([
      "take:/d/a",
      "lost:Events were dropped by the FSEvents client",
      "take:/d/b",
    ]);
  });
});

describe.skipIf(process.platform !== "darwin")(
  "createFileWatcher: shared FSEvents streams",
  () => {
    const start = (
      of: string,
      depth: "subtree" | "children",
      heard: FileChangeEvent[],
      onLost?: (error: unknown) => void,
    ): Promise<FileWatcher> =>
      createFileWatcher({
        dirs: [of],
        depth,
        debounceMs: 0,
        onChange: (batch) => void heard.push(...batch),
        ...(onLost ? { onLost: (_d: string, e: unknown) => onLost(e) } : {}),
      });
    const streamsUnder = (root: string) =>
      fsEventsStreams().open.filter((s) => s.root.startsWith(root));
    // A children watch rides the pool only past kqueue's entry budget.
    const pastBudget = (of: string): void => {
      for (let i = 0; i <= KQUEUE_CHILDREN_OPEN_BUDGET; i++)
        writeFileSync(join(of, `pad${i}`), "");
    };

    test("watches under an open recursive stream ride it: one stream, each hears its own scope", async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-pool-")));
      const a = join(dir, "a");
      const b = join(a, "b");
      mkdirSync(join(b, "deep"), { recursive: true });
      pastBudget(b);
      const top: FileChangeEvent[] = [];
      const kids: FileChangeEvent[] = [];
      const sub: FileChangeEvent[] = [];
      watcher = await start(dir, "subtree", top);
      const opened = fsEventsStreams().opened;
      const w1 = await start(b, "children", kids);
      const w2 = await start(a, "subtree", sub);
      try {
        expect(fsEventsStreams().opened).toBe(opened);
        expect(streamsUnder(dir)).toEqual([
          { root: dir, depth: "subtree", riders: 3 },
        ]);
        // Live at resolve, with nothing opened: written at once.
        writeFileSync(join(b, "f.txt"), "x");
        writeFileSync(join(b, "deep", "g.txt"), "x");
        await until(
          () =>
            kids.some((e) => e.path === join(b, "f.txt")) &&
            sub.some((e) => e.path === join(b, "deep", "g.txt")),
        );
        expect(kids.map((e) => e.path)).toContain(join(b, "f.txt"));
        expect(kids.map((e) => e.path)).not.toContain(join(b, "deep", "g.txt"));
        expect(sub.every((e) => e.path.startsWith(a))).toBe(true);
      } finally {
        await w1.stop();
        await w2.stop();
      }
      expect(streamsUnder(dir)).toEqual([
        { root: dir, depth: "subtree", riders: 1 },
      ]);
    });

    test("children watches of one dir share one stream; the last to stop closes it", async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-pool-")));
      pastBudget(dir);
      const w1 = await start(dir, "children", []);
      const w2 = await start(dir, "children", []);
      expect(streamsUnder(dir)).toEqual([
        { root: dir, depth: "children", riders: 2 },
      ]);
      await w1.stop();
      expect(streamsUnder(dir)).toHaveLength(1);
      await w2.stop();
      expect(streamsUnder(dir)).toEqual([]);
    });

    test("a rider's dir going is reported to it alone; the stream and its other riders keep hearing", async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-pool-")));
      const doomed = join(dir, "doomed");
      const listed = join(dir, "listed");
      mkdirSync(join(doomed, "x"), { recursive: true });
      mkdirSync(listed);
      pastBudget(listed);
      const top: FileChangeEvent[] = [];
      watcher = await start(dir, "subtree", top);
      const lost: unknown[] = [];
      const kids: FileChangeEvent[] = [];
      const deep = await start(doomed, "subtree", [], (e) => lost.push(e));
      const entries = await start(listed, "children", kids);
      try {
        // Moved away whole: FSEvents names only the folder that moved.
        renameSync(doomed, join(tmpdir(), `fw-pool-moved-${Date.now()}`));
        rmSync(listed, { recursive: true });
        await until(
          () => lost.length > 0 && kids.some((e) => e.path === listed),
        );
        expect(lost[0]).toBeInstanceOf(WatchedDirGoneError);
        expect(kids.filter((e) => e.path === listed)).toEqual([
          { type: "delete", path: listed },
        ]);
        expect(streamsUnder(dir)).toEqual([
          { root: dir, depth: "subtree", riders: 1 },
        ]);
        writeFileSync(join(dir, "after.txt"), "x");
        await until(() => top.some((e) => e.path === join(dir!, "after.txt")));
        expect(top.map((e) => e.path)).toContain(join(dir, "after.txt"));
      } finally {
        await deep.stop();
        await entries.stop();
      }
    });

    test("a stream opening above an open one leaves its riders where they are", async () => {
      // Moving them would drop what fseventsd queued for the lower stream.
      dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-pool-")));
      const low = join(dir, "low");
      mkdirSync(low);
      const kids: FileChangeEvent[] = [];
      const w1 = await start(low, "subtree", kids);
      watcher = await start(dir, "subtree", []);
      try {
        expect(streamsUnder(dir)).toHaveLength(2);
        writeFileSync(join(low, "f.txt"), "x");
        await until(() => kids.some((e) => e.path === join(low, "f.txt")));
        expect(kids.map((e) => e.path)).toContain(join(low, "f.txt"));
      } finally {
        await w1.stop();
      }
      expect(streamsUnder(dir)).toEqual([
        { root: dir, depth: "subtree", riders: 1 },
      ]);
    });

    test("a watch with an ignore neither rides nor carries others", async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-pool-")));
      watcher = await createFileWatcher({
        dirs: [dir],
        ignore: ["**/skip/**"],
        debounceMs: 0,
        onChange: () => {},
      });
      pastBudget(dir);
      const w = await start(dir, "children", []);
      try {
        expect(streamsUnder(dir)).toEqual([
          { root: dir, depth: "children", riders: 1 },
        ]);
      } finally {
        await w.stop();
      }
    });
  },
);

describe.skipIf(process.platform !== "darwin")(
  "createFileWatcher: children watches on kqueue",
  () => {
    const start = (
      of: string,
      heard: FileChangeEvent[],
    ): Promise<FileWatcher> =>
      createFileWatcher({
        dirs: [of],
        depth: "children",
        debounceMs: 0,
        onChange: (batch) => void heard.push(...batch),
      });
    const streamsUnder = (root: string) =>
      fsEventsStreams().open.filter((s) => s.root.startsWith(root));

    test("opens no FSEvents stream: a descriptor on the dir and one per entry", async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-kq-")));
      for (const name of ["a", "b", "c"]) writeFileSync(join(dir, name), "");
      mkdirSync(join(dir, "sub", "deep"), { recursive: true });
      const opened = fsEventsStreams().opened;
      const heard: FileChangeEvent[] = [];
      watcher = await start(dir, heard);
      expect(fsEventsStreams().opened).toBe(opened);
      expect(streamsUnder(dir)).toEqual([]);
      // The dir, a, b, c and sub — nothing below sub.
      expect(descriptorsUnder(dir)).toBe(5);
      writeFileSync(join(dir, "sub", "deep", "x"), "x");
      appendFileSync(join(dir, "a"), "more");
      await until(() => heard.some((e) => e.path === join(dir!, "a")));
      expect(heard).toContainEqual({ type: "update", path: join(dir, "a") });
      expect(heard.every((e) => !e.path.includes("/deep"))).toBe(true);
      await watcher.stop();
      watcher = null;
      expect(descriptorsUnder(dir)).toBe(0);
    });

    test("hears an atomic rename-over write of an entry", async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-kq-")));
      const target = join(dir, "status.json");
      writeFileSync(target, "0");
      const heard: FileChangeEvent[] = [];
      watcher = await start(dir, heard);
      for (let i = 0; i < 20; i++) {
        const from = heard.length;
        const staging = join(dir, `.status.${i}.tmp`);
        writeFileSync(staging, String(i));
        renameSync(staging, target);
        await until(() => heard.slice(from).some((e) => e.path === target));
        expect(heard.slice(from).map((e) => e.path)).toContain(target);
      }
    });

    test("an entry it may not list or open is listed, not watched, and the watch opens", async () => {
      // `~/.Trash` without Full Disk Access: upstream parcel failed the open.
      dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-kq-")));
      const locked = join(dir, "locked");
      mkdirSync(join(locked, "inner"), { recursive: true });
      chmodSync(locked, 0o000);
      try {
        const heard: FileChangeEvent[] = [];
        watcher = await start(dir, heard);
        writeFileSync(join(dir, "f.txt"), "x");
        await until(() => heard.some((e) => e.path === join(dir!, "f.txt")));
        expect(heard.map((e) => e.path)).toContain(join(dir, "f.txt"));
      } finally {
        chmodSync(locked, 0o755);
      }
    });

    test("a dir past the open budget rides the FSEvents pool", async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-kq-")));
      for (let i = 0; i <= KQUEUE_CHILDREN_OPEN_BUDGET; i++)
        writeFileSync(join(dir, `f${i}`), "");
      const reserved = kqueueChildrenReserved();
      watcher = await start(dir, []);
      expect(kqueueChildrenReserved()).toBe(reserved);
      expect(streamsUnder(dir)).toEqual([
        { root: dir, depth: "children", riders: 1 },
      ]);
    });

    test("a dir growing past the cap moves to the FSEvents pool, every entry heard", async () => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "fw-kq-")));
      const heard = new Set<string>();
      let lost = 0;
      const reserved = kqueueChildrenReserved();
      watcher = await createFileWatcher({
        dirs: [dir],
        depth: "children",
        debounceMs: 0,
        onChange: (batch) => {
          for (const e of batch) if (e.type !== "delete") heard.add(e.path);
        },
        onLost: () => void (lost += 1),
      });
      const written: string[] = [];
      for (let i = 0; i <= KQUEUE_CHILDREN_CAP + 50; i++) {
        const file = join(dir, `f${i}`);
        writeFileSync(file, "");
        written.push(file);
      }
      // The pool ride opens first; the kqueue subscription closes after it.
      await until(
        () =>
          streamsUnder(dir!).length === 1 &&
          kqueueChildrenReserved() === reserved,
      );
      expect(streamsUnder(dir)).toEqual([
        { root: dir, depth: "children", riders: 1 },
      ]);
      expect(kqueueChildrenReserved()).toBe(reserved);
      const after = join(dir, "after");
      writeFileSync(after, "");
      written.push(after);
      // FSEvents may be seconds late under load: wait longer than `until`.
      // A dropped batch (fseventsd overloaded) is reported, never silent.
      const missing = () => written.filter((f) => !heard.has(f));
      for (let i = 0; i < 1500 && lost === 0 && missing().length > 0; i++)
        await Bun.sleep(20);
      if (lost === 0) expect(missing()).toEqual([]);
    }, 60_000);
  },
);
