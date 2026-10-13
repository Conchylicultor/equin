import { describe, expect, test } from "bun:test";
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

  test("a sync reaction runs inline", () => {
    let calls = 0;
    const c = createCoalescer({ run: () => void (calls += 1) });
    c.trigger();
    expect(calls).toBe(1);
  });
});

describe("createKeyedCoalescer", () => {
  test("keys run independently; each is bounded on its own", async () => {
    const gates = new Map<string, () => void>();
    const runs: string[] = [];
    const c = createKeyedCoalescer<string>({
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
