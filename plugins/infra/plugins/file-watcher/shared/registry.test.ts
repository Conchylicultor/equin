import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECENT_RUNS_MAX } from "@plugins/infra/plugins/background/plugins/catalog/core";
import type { FileWatcher } from "./engine";
import {
  defineFileWatcherIn,
  fileWatcherRecentRuns,
  listFileWatchers,
  onWatcherActivity,
  type FileWatcherRuntime,
  type FileWatcherSnapshot,
} from "./registry";

// What `onFailure` was handed. The server's rethrows (an unhandled rejection
// the reports plugin files); a test collects instead.
const failuresSeen: unknown[] = [];

function runtime(
  overrides: Partial<FileWatcherRuntime> = {},
): FileWatcherRuntime {
  return {
    scope: "every-worktree",
    runsHere: true,
    declaredIn: () => "test.plugin",
    onFailure: (_name, err) => {
      failuresSeen.push(err);
    },
    ...overrides,
  };
}

function snapshot(name: string): FileWatcherSnapshot {
  const s = listFileWatchers().find((w) => w.name === name);
  if (s === undefined) throw new Error(`not registered: ${name}`);
  return s;
}

/** Resolve once `predicate` holds, re-checked on every registry announcement
 * and on the reconcile ticks that drive most of these tests. */
function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      off();
      clearInterval(tick);
      reject(new Error("timed out"));
    }, timeoutMs);
    const check = (): void => {
      if (!predicate()) return;
      clearTimeout(deadline);
      clearInterval(tick);
      off();
      resolve();
    };
    const off = onWatcherActivity(check);
    // Runs are announced only on an outcome change or a quiet minute, so a
    // count-based predicate needs its own re-check.
    const tick = setInterval(check, 10);
    check();
  });
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test, so awaiting it
 * is an `await` of a non-Thenable — this asserts the rejection for real.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

let dir: string;
const open: FileWatcher[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fw-registry-"));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((w) => w.stop()));
  rmSync(dir, { recursive: true, force: true });
});

describe("defineFileWatcherIn", () => {
  test("an empty description throws at define time", () => {
    expect(() =>
      defineFileWatcherIn({ name: "t.no-desc", description: "  " }, runtime()),
    ).toThrow(/description is required/);
  });

  test("refuses to start before it is registered", async () => {
    const w = defineFileWatcherIn(
      { name: "t.unregistered", description: "d" },
      runtime(),
    );
    expect(
      (await rejection(w.start({ dirs: [dir], onChange: () => {} }))).message,
    ).toMatch(/before it was registered/);
  });

  test("a duplicate name throws on register", () => {
    defineFileWatcherIn(
      { name: "t.dup", description: "d" },
      runtime(),
    ).register();
    const second = defineFileWatcherIn(
      { name: "t.dup", description: "d" },
      runtime(),
    );
    expect(() => second.register()).toThrow(/duplicate watcher name: t\.dup/);
  });

  test("a main-only watcher refuses to start off main", async () => {
    const w = defineFileWatcherIn(
      { name: "t.main-only", description: "d" },
      runtime({ scope: "main", runsHere: false }),
    );
    w.register();
    expect(
      (await rejection(w.start({ dirs: [dir], onChange: () => {} }))).message,
    ).toMatch(/main-only/);
    expect(snapshot("t.main-only")).toMatchObject({
      scope: "main",
      runsHere: false,
      instances: [],
    });
  });

  test("instances are listed on start and dropped on stop", async () => {
    const w = defineFileWatcherIn(
      { name: "t.instances", description: "Watches a temp dir." },
      runtime(),
    );
    w.register();
    const announced: string[] = [];
    const off = onWatcherActivity((n) => announced.push(n));
    const a = await w.start({ dirs: [dir], label: "a", onChange: () => {} });
    const b = await w.start({ dirs: [dir], onChange: () => {} });
    expect(snapshot("t.instances").instances.map((i) => i.label)).toEqual([
      "a",
      null,
    ]);
    expect(snapshot("t.instances")).toMatchObject({
      description: "Watches a temp dir.",
      declaredIn: "test.plugin",
      reconcileMs: null,
    });
    await a.stop();
    await a.stop(); // idempotent
    expect(snapshot("t.instances").instances.map((i) => i.label)).toEqual([
      null,
    ]);
    await b.stop();
    expect(snapshot("t.instances").instances).toEqual([]);
    off();
    expect(announced.filter((n) => n === "t.instances")).toHaveLength(4);
  });

  test("a change batch is recorded as the last batch and a run", async () => {
    const w = defineFileWatcherIn(
      { name: "t.batch", description: "d", debounceMs: 0 },
      runtime(),
    );
    w.register();
    const seen: string[] = [];
    open.push(
      await w.start({
        dirs: [dir],
        onChange: (events) => void seen.push(...events.map((e) => e.path)),
      }),
    );
    writeFileSync(join(dir, "a.txt"), "x");
    await until(() => snapshot("t.batch").runs >= 1);
    const s = snapshot("t.batch");
    expect(s.lastBatch?.samplePaths.some((p) => p.endsWith("a.txt"))).toBe(
      true,
    );
    expect(s.lastBatch?.eventCount).toBeGreaterThanOrEqual(1);
    expect(s.recentRuns[0]?.outcome).toBe("succeeded");
    expect(s.lastSuccessAt).not.toBeNull();
    expect(seen.some((p) => p.endsWith("a.txt"))).toBe(true);
  });

  test("reconcile ticks are runs, and the ring is capped", async () => {
    const w = defineFileWatcherIn(
      { name: "t.ring", description: "d", reconcileMs: 2 },
      runtime(),
    );
    w.register();
    let ticks = 0;
    open.push(
      await w.start({
        dirs: [dir],
        onChange: () => {},
        onReconcile: () => {
          ticks += 1;
        },
      }),
    );
    await until(() => snapshot("t.ring").runs > RECENT_RUNS_MAX + 5);
    const s = snapshot("t.ring");
    expect(s.recentRuns).toHaveLength(RECENT_RUNS_MAX);
    expect(await fileWatcherRecentRuns("t.ring")).toHaveLength(RECENT_RUNS_MAX);
    expect(s.runs).toBeGreaterThanOrEqual(ticks - 1);
    expect(s.reconcileMs).toBe(2);
  });

  test("a throwing handler is recorded as failed and handed to onFailure", async () => {
    const w = defineFileWatcherIn(
      { name: "t.throws", description: "d", reconcileMs: 5 },
      runtime(),
    );
    w.register();
    open.push(
      await w.start({
        dirs: [dir],
        onChange: () => {},
        onReconcile: () => {
          throw new Error("boom");
        },
      }),
    );
    await until(
      () => snapshot("t.throws").failures >= 1 && failuresSeen.length >= 1,
    );
    const s = snapshot("t.throws");
    expect(s.recentRuns[0]).toMatchObject({ outcome: "failed", error: "boom" });
    expect(s.lastSuccessAt).toBeNull();
    expect(
      failuresSeen.some((e) => e instanceof Error && e.message === "boom"),
    ).toBe(true);
  });

  test("an async handler's rejection is recorded as failed", async () => {
    const w = defineFileWatcherIn(
      { name: "t.async-throws", description: "d", reconcileMs: 5 },
      runtime(),
    );
    w.register();
    // A handler that returns its promise is timed until it settles.
    const rejectLater = (() =>
      Promise.reject(new Error("later"))) as unknown as () => void;
    open.push(
      await w.start({
        dirs: [dir],
        onChange: () => {},
        onReconcile: rejectLater,
      }),
    );
    await until(
      () =>
        snapshot("t.async-throws").failures >= 1 && failuresSeen.length >= 1,
    );
    expect(snapshot("t.async-throws").recentRuns[0]).toMatchObject({
      outcome: "failed",
      error: "later",
    });
  });

  test("an unknown name has no recent runs", async () => {
    expect((await rejection(fileWatcherRecentRuns("t.nope"))).message).toMatch(
      /no watcher named "t\.nope"/,
    );
  });
});
