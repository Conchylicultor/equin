import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWatcher,
  parcelBatchHandler,
  WRITES_WHILE_OPEN_MAX_ENTRIES,
  type FileWatcher,
} from "./engine";

let dir: string | null = null;
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
