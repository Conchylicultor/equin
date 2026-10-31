import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWatcher,
  parcelBatchHandler,
  WRITES_WHILE_OPEN_MAX_ENTRIES,
  type FileWatcher,
} from "./engine";

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

describe("createFileWatcher: writesWhileOpen", () => {
  test("reports appends to a file another process still holds open", async () => {
    // macOS FSEvents (the default backend there) reports this file's change
    // only when the writer closes its descriptor. The writer below keeps it
    // open past the test, so three events can only come from per-write reports.
    dir = mkdtempSync(join(tmpdir(), "fw-open-"));
    const file = join(dir, "held.log");
    writeFileSync(file, "");
    let events = 0;
    watcher = await createFileWatcher({
      dirs: [dir],
      writesWhileOpen: true,
      debounceMs: 0,
      onChange: (batch) => {
        events += batch.length;
      },
    });
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

  test("refuses a directory too large for a descriptor per entry", async () => {
    if (process.platform !== "darwin") return; // the guard binds only on kqueue
    dir = mkdtempSync(join(tmpdir(), "fw-big-"));
    for (let i = 0; i <= WRITES_WHILE_OPEN_MAX_ENTRIES; i++) {
      writeFileSync(join(dir, `f${i}`), "");
    }
    let error: unknown = null;
    try {
      watcher = await createFileWatcher({
        dirs: [dir],
        writesWhileOpen: true,
        onChange: () => {},
      });
    } catch (err) {
      error = err;
    }
    expect(String(error)).toContain("writesWhileOpen");
  });
});

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
  // kqueue on darwin, inotify on Linux: both watch each directory on its own.
  test("reports what it held, and hears every later write to it", async () => {
    dir = mkdtempSync(join(tmpdir(), "fw-moved-"));
    const heard: string[] = [];
    watcher = await createFileWatcher({
      dirs: [dir],
      writesWhileOpen: true,
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
    dir = mkdtempSync(join(tmpdir(), "fw-moved-ignore-"));
    const heard: string[] = [];
    watcher = await createFileWatcher({
      dirs: [dir],
      writesWhileOpen: true,
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
