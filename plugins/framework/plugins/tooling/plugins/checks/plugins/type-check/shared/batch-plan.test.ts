/**
 * The batch plan (`./batch-plan.ts`): a batch is dispatched only once what its
 * files import is done; a cycle is never split; the environment goes first;
 * ready work is shared across the width.
 */
import { expect, test } from "bun:test";
import { planBatches, type BatchPlanInput } from "./batch-plan";

/** Run the plan to the end, one batch at a time; the batches in order. */
function drain(input: BatchPlanInput): string[][] {
  const plan = planBatches(input);
  const out: string[][] = [];
  for (;;) {
    const b = plan.next(0);
    if (b === undefined) break;
    out.push(b);
    plan.done(b);
  }
  expect(plan.finished()).toBe(true);
  return out;
}

const graph =
  (edges: Record<string, string[]>) =>
  (p: string): string[] =>
    edges[p] ?? [];

test("a batch comes after every batch holding what its files import", () => {
  const deps = { a: ["b"], b: ["c"], c: [], d: ["c"] };
  const batches = drain({
    files: Object.keys(deps),
    deps: graph(deps),
    environment: [],
    globals: [],
    k: 1,
    width: 1,
  });
  const at = new Map(batches.flatMap((b, i) => b.map((p) => [p, i] as const)));
  for (const [p, ds] of Object.entries(deps)) {
    for (const d of ds) expect(at.get(d)!).toBeLessThan(at.get(p)!);
  }
  expect(batches.every((b) => b.length === 1)).toBe(true);
});

test("an import cycle is one batch, larger than k if it must be", () => {
  const deps = { a: ["b"], b: ["c"], c: ["a"], d: ["a"] };
  const plan = planBatches({
    files: Object.keys(deps),
    deps: graph(deps),
    environment: [],
    globals: [],
    k: 1,
    width: 1,
  });
  expect(plan.largest).toBe(3);
  expect(plan.components).toBe(2);
  expect(plan.depth).toBe(2);
  const first = plan.next(0)!;
  expect(first.sort()).toEqual(["a", "b", "c"]);
  expect(plan.next(1)).toBeUndefined();
  plan.done(first);
  expect(plan.next(0)).toEqual(["d"]);
});

test("the environment and what it imports are done before anything else", () => {
  // `env` is in every program (a repo .d.ts root imports it):
  // `x`, which nothing else waits on, still goes after it.
  const deps = { x: [], env: ["lib"], lib: [], y: ["x"] };
  const batches = drain({
    files: Object.keys(deps),
    deps: graph(deps),
    environment: ["env", "not-in-the-set"],
    globals: [],
    k: 1,
    width: 1,
  });
  expect(batches.slice(0, 2)).toEqual([["lib"], ["env"]]);
});

test("ready work is shared across the width, at most k a batch", () => {
  const files = ["a", "b", "c", "d", "e", "f"];
  const plan = planBatches({
    files,
    deps: () => [],
    environment: [],
    globals: [],
    k: 10,
    width: 3,
  });
  const first = plan.next(0)!;
  const second = plan.next(1)!;
  const third = plan.next(2)!;
  expect([first.length, second.length, third.length]).toEqual([2, 2, 2]);
  expect([...first, ...second, ...third].sort()).toEqual(files);
  const small = planBatches({
    files,
    deps: () => [],
    environment: [],
    globals: [],
    k: 4,
    width: 1,
  });
  expect(small.next(0)!.length).toBe(4);
});

test("the heaviest chain is dispatched first", () => {
  // `deep` has three files waiting on it, `shallow` none.
  const deps = { shallow: [], deep: [], u1: ["deep"], u2: ["u1"], u3: ["u2"] };
  const plan = planBatches({
    files: Object.keys(deps),
    deps: graph(deps),
    environment: [],
    globals: [],
    k: 1,
    width: 2,
  });
  expect(plan.next(0)).toEqual(["deep"]);
});

test("a global file and what it imports are one batch, before everything else", () => {
  // `aug` augments `g`: its program needs g's .d.ts, and g's program needs
  // aug's (every program holds a global file).
  const deps = { aug: ["g"], g: [], user: ["g"], other: [] };
  const batches = drain({
    files: Object.keys(deps),
    deps: graph(deps),
    environment: [],
    globals: ["aug"],
    k: 1,
    width: 1,
  });
  expect(batches[0]!.sort()).toEqual(["aug", "g"]);
  expect(batches.length).toBe(3);
});

test("a batch grows along what waits on it, up to k", () => {
  // c → b → a: one batch of three at k = 3, not three levels.
  const deps = { a: [], b: ["a"], c: ["b"], d: ["c"] };
  const batches = drain({
    files: Object.keys(deps),
    deps: graph(deps),
    environment: [],
    globals: [],
    k: 3,
    width: 1,
  });
  expect(batches).toEqual([["a", "b", "c"], ["d"]]);
});

test("an import of a file outside the set is followed through it, cycles and the environment included", () => {
  // `a` imports `z`, outside, a barrel over `y`; `z` and `w` (outside) import
  // each other; `env` (outside, the environment) imports `e`.
  const deps = {
    a: ["z"],
    y: [],
    z: ["w"],
    w: ["z", "y"],
    env: ["e"],
    e: [],
  };
  const batches = drain({
    files: ["a", "y", "e"],
    deps: graph(deps),
    environment: ["env"],
    globals: [],
    k: 1,
    width: 1,
  });
  expect(batches).toEqual([["e"], ["y"], ["a"]]);
});
