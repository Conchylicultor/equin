import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWatcher,
  parcelBatchHandler,
  WatchedDirGoneError,
  type FileWatcher,
  type FileWatcherOptions,
} from "./engine";
import { followedDirs } from "./follow-files";

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
