import { afterAll, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  installAsyncContextRuntime,
  installSpanContextRuntime,
  onSlowSpan,
  recordEntrySpan,
  type EntryContext,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { createCoalescer, createKeyedCoalescer } from "./coalesce";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createCoalescer", () => {
  test("a flood against slow work costs one running plus one pending run", async () => {
    const gates: (() => void)[] = [];
    const batches: number[][] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const c = createCoalescer<number>({
      name: "test",
      run: async (items) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        batches.push(items);
        const gate = deferred();
        gates.push(gate.resolve);
        await gate.promise;
        concurrent -= 1;
      },
    });

    for (let i = 0; i < 1000; i++) c.trigger([i]);
    expect(batches).toEqual([[0]]);
    expect(c.stats()).toEqual({ triggers: 1000, runs: 1, folded: 998 });

    gates[0]!();
    await tick();
    // The 999 triggers that landed mid-run are ONE trailing run, items merged.
    expect(batches.length).toBe(2);
    expect(batches[1]!.length).toBe(999);
    expect(batches[1]![0]).toBe(1);

    gates[1]!();
    await c.idle();
    expect(batches.length).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  test("a trigger mid-run is answered by a run that starts after it", async () => {
    const seen: string[] = [];
    let state = "old";
    const gate = deferred();
    const c = createCoalescer({
      name: "test",
      run: async () => {
        const read = state;
        if (seen.length === 0) await gate.promise;
        seen.push(read);
      },
    });
    c.trigger();
    state = "new";
    const covering = c.run();
    gate.resolve();
    await covering;
    expect(seen).toEqual(["old", "new"]);
  });

  test("run() resolves only after the covering run settles", async () => {
    const gate = deferred();
    let finished = 0;
    const c = createCoalescer({
      name: "test",
      run: async () => {
        await gate.promise;
        finished += 1;
      },
    });
    const p = c.run();
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    gate.resolve();
    await p;
    expect(finished).toBe(1);
  });

  test("a failing run rejects its waiters and still starts the pending run", async () => {
    const gate = deferred();
    let calls = 0;
    const c = createCoalescer({
      name: "test",
      run: async () => {
        calls += 1;
        if (calls === 1) {
          await gate.promise;
          throw new Error("boom");
        }
      },
    });
    const first = c.run();
    const second = c.run();
    gate.resolve();
    let error: unknown = null;
    try {
      await first;
    } catch (err) {
      error = err;
    }
    expect((error as Error).message).toBe("boom");
    await second;
    expect(calls).toBe(2);
  });

  test("settled() waits for the running and pending runs, never a later trigger", async () => {
    const gates: (() => void)[] = [];
    const batches: number[][] = [];
    const c = createCoalescer<number>({
      name: "test",
      run: async (items) => {
        batches.push(items);
        const gate = deferred();
        gates.push(gate.resolve);
        await gate.promise;
      },
    });
    await c.settled(); // nothing running: at once
    c.trigger([1]);
    c.trigger([2]); // pending behind [1]
    let settled = false;
    void c.settled().then(() => {
      settled = true;
    });
    gates[0]!();
    await tick();
    expect(batches).toEqual([[1], [2]]);
    c.trigger([3]); // lands after the call: folded behind [2], not waited for
    expect(settled).toBe(false);
    gates[1]!();
    await tick();
    expect(settled).toBe(true);
    expect(batches).toEqual([[1], [2], [3]]);
    gates[2]!();
    await c.idle();
  });

  test("settled() resolves after a failed run too", async () => {
    const gate = deferred();
    const c = createCoalescer({
      name: "test",
      run: async () => {
        await gate.promise;
        throw new Error("boom");
      },
    });
    const run = c.run();
    const settled = c.settled();
    gate.resolve();
    expect(run).rejects.toThrow("boom");
    await settled;
  });

  test("a sync reaction runs inline", () => {
    let calls = 0;
    const c = createCoalescer({ name: "test", run: () => void (calls += 1) });
    c.trigger();
    expect(calls).toBe(1);
  });
});

describe("createKeyedCoalescer", () => {
  test("keys run independently; each is bounded on its own", async () => {
    const gates = new Map<string, () => void>();
    const runs: string[] = [];
    const c = createKeyedCoalescer<string>({
      name: "test",
      run: async (key) => {
        runs.push(key);
        const gate = deferred();
        gates.set(key, gate.resolve);
        await gate.promise;
      },
    });
    for (let i = 0; i < 50; i++) {
      c.trigger("a");
      c.trigger("b");
    }
    expect(runs).toEqual(["a", "b"]);
    gates.get("a")!();
    gates.get("b")!();
    await tick();
    expect(runs).toEqual(["a", "b", "a", "b"]);
    gates.get("a")!();
    gates.get("b")!();
    await Promise.all([c.idle("a"), c.idle("b")]);
    expect(c.stats().runs).toBe(4);
  });
});

describe("waits on another caller's run", () => {
  // What runtime-profiler/server installs at boot.
  const als = new AsyncLocalStorage<EntryContext>();
  installSpanContextRuntime({
    run: (ctx, fn) => als.run(ctx, fn),
    current: () => als.getStore(),
  });

  /** The waits a `run` caller's span recorded, by layer. */
  async function waitsOfCaller(
    c: { run(): Promise<void> },
    label: string,
  ): Promise<Record<string, number>> {
    let waits: Record<string, number> | undefined;
    const sub = onSlowSpan(
      (span) => {
        if (span.label === label) waits = { ...span.waits };
      },
      { thresholdMs: 0 },
    );
    try {
      await recordEntrySpan("http", label, () => c.run());
    } finally {
      sub.dispose();
    }
    return waits ?? {};
  }

  test("a run folded behind one in flight is a named join, not own time", async () => {
    const gate = deferred();
    let first = true;
    const c = createCoalescer({
      name: "probe",
      run: async () => {
        if (!first) return;
        first = false;
        await gate.promise;
      },
    });
    c.trigger(); // another party's run, in flight
    const waiting = waitsOfCaller(c, "folded-reader");
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    const waits = await waiting;
    expect(waits["coalesce:probe"]).toBeGreaterThanOrEqual(15);
  });

  test("a run this caller starts is its own work: no join", async () => {
    const c = createCoalescer({
      name: "probe-own",
      run: () => new Promise<void>((r) => setTimeout(r, 10)),
    });
    const waits = await waitsOfCaller(c, "starting-reader");
    expect(waits["coalesce:probe-own"]).toBeUndefined();
  });
});

describe("the context a run starts in", () => {
  const who = new AsyncLocalStorage<string>();
  installAsyncContextRuntime({
    root: (fn) => fn(),
    capture: () => AsyncLocalStorage.snapshot(),
  });
  afterAll(() => {
    installAsyncContextRuntime({
      root: (fn) => fn(),
      capture: () => (fn) => fn(),
    });
  });

  test("a trailing run starts in the context of the trigger that asked for it first, never the previous run's", async () => {
    const gate = deferred();
    const startedIn: (string | undefined)[] = [];
    const c = createCoalescer<number>({
      name: "probe-context",
      run: async (items) => {
        startedIn.push(who.getStore());
        if (items[0] === 0) await gate.promise;
      },
    });
    // The first run is the boot hook's; the triggers landing mid-run are a
    // file change's, then a later caller's (folded into the same run).
    const first = who.run("boot-hook", () => c.run([0]));
    who.run("file-change", () => c.trigger([1]));
    who.run("later", () => c.trigger([2]));
    gate.resolve();
    await first;
    await c.idle();
    expect(startedIn).toEqual(["boot-hook", "file-change"]);
  });
});
