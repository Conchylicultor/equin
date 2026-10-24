// THE BATCH PLAN: the order a large set of files is checked in, so that no
// program holds more than K of them
// (research/2026-10-23-global-type-check-bounded-batches.md).
//
// A file is checked against the `.d.ts` of what it imports, so a set too large
// for one program is checked in DEPENDENCY ORDER: a batch is dispatched once
// every file it imports from OUTSIDE the batch is done, and is served their
// just-emitted `.d.ts`; inside a batch files see each other as source. An
// import cycle (a strongly connected component) is never split, so a batch
// holds at most max(K, the largest cycle) files.
//
// The ENVIRONMENT goes first: the repo sources a repo `.d.ts` root imports are
// in every program, so they (and what they import) are done before any other
// batch is dispatched. A GLOBAL source file is seen by every file without an
// import, so it counts as an import of each: what it imports itself then
// shares its component (each needs the other's `.d.ts`), as in one program.
//
// Ready components are dispatched largest-downstream first (the critical path
// starts early), and each batch takes a fair share of what is ready —
// min(K, ⌈ready / width⌉) files — so `width` processes start at once instead
// of the first taking everything (Phase A, Q4). Then it GROWS, up to K, along
// what waits on it: otherwise a batch is one level of the graph, and a run is
// at least as many programs as the graph is deep (measured: 101 programs at
// K = 1000, +38 % CPU over one program).

import { forEachComponent } from "./keys";

export interface BatchPlanInput {
  /** The files to check. */
  files: readonly string[];
  /** The files `p` imports (anything outside `files` is ignored: it is served). */
  deps(p: string): Iterable<string>;
  /** Files every program holds: done, with what they import, before the rest. */
  environment: Iterable<string>;
  /** Global files: seen by every other file, as if each imported them. */
  globals: Iterable<string>;
  /** The most files one batch holds (a larger cycle is a batch of its own). */
  k: number;
  /** How many batches run at once. */
  width: number;
}

export interface BatchPlan {
  /** Components (cycles counted once) and the largest one. */
  readonly components: number;
  readonly largest: number;
  /** The longest chain of components, end to end. */
  readonly depth: number;
  /**
   * The next batch to dispatch, `running` batches being out: undefined when
   * nothing is ready (wait for one to finish), or everything is dispatched.
   */
  next(running: number): string[] | undefined;
  /** A dispatched batch finished: what imports it may become ready. */
  done(batch: readonly string[]): void;
  /** Every file dispatched and done. */
  finished(): boolean;
}

export function planBatches(input: BatchPlanInput): BatchPlan {
  const { k, width } = input;
  if (!(k >= 1) || !(width >= 1)) {
    throw new Error(`batch plan: k (${k}) and width (${width}) must be ≥ 1`);
  }
  const files = [...input.files].sort();
  const index = new Map(files.map((p, i) => [p, i]));
  const globals = [...input.globals].flatMap((g) => {
    const j = index.get(g);
    return j === undefined ? [] : [j];
  });
  const out: number[][] = files.map((p, i) => {
    const seen = new Set<number>(globals);
    for (const d of input.deps(p)) {
      const j = index.get(d);
      if (j !== undefined) seen.add(j);
    }
    seen.delete(i);
    return [...seen].sort((a, b) => a - b);
  });

  // ── Components (an import cycle is one): never split across batches ──
  const comp = new Array<number>(files.length).fill(-1);
  const members: number[][] = [];
  forEachComponent(
    files.map((_, i) => i),
    (v) => out[v]!,
    (ms) => {
      for (const v of ms) comp[v] = members.length;
      members.push([...ms].sort((a, b) => a - b));
    },
  );
  const n = members.length;
  const deps: Set<number>[] = members.map(() => new Set<number>());
  for (let v = 0; v < files.length; v++) {
    for (const w of out[v]!) {
      if (comp[v] !== comp[w]) deps[comp[v]!]!.add(comp[w]!);
    }
  }

  // ── The environment's closure first: every other component waits on it ──
  const envClosure = new Set<number>();
  const envStack: number[] = [];
  for (const p of input.environment) {
    const j = index.get(p);
    if (j !== undefined) envStack.push(comp[j]!);
  }
  while (envStack.length > 0) {
    const c = envStack.pop()!;
    if (envClosure.has(c)) continue;
    envClosure.add(c);
    for (const d of deps[c]!) envStack.push(d);
  }
  if (envClosure.size > 0) {
    for (let c = 0; c < n; c++) {
      if (envClosure.has(c)) continue;
      for (const e of envClosure) deps[c]!.add(e);
    }
  }

  // ── Dependants, a topological order (dependencies first), and each
  //    component's downstream weight: its files plus the heaviest chain of
  //    what waits on it ──
  const dependants: number[][] = members.map(() => []);
  for (let c = 0; c < n; c++) for (const d of deps[c]!) dependants[d]!.push(c);
  const waiting = deps.map((s) => s.size);
  const topo: number[] = [];
  {
    const left = [...waiting];
    for (let c = 0; c < n; c++) if (left[c] === 0) topo.push(c);
    for (let i = 0; i < topo.length; i++) {
      for (const x of dependants[topo[i]!]!) {
        if (--left[x]! === 0) topo.push(x);
      }
    }
    if (topo.length !== n) {
      throw new Error(
        `batch plan: the component graph has a cycle (${topo.length} of ${n} ordered)`,
      );
    }
  }
  const weight = new Array<number>(n).fill(0);
  const chain = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const c = topo[i]!;
    let w = 0;
    let h = 0;
    for (const x of dependants[c]!) {
      w = Math.max(w, weight[x]!);
      h = Math.max(h, chain[x]!);
    }
    weight[c] = members[c]!.length + w;
    chain[c] = 1 + h;
  }

  const ready = new Set<number>();
  for (let c = 0; c < n; c++) if (waiting[c] === 0) ready.add(c);
  const compOf = new Map<string, number>();
  for (let c = 0; c < n; c++) {
    for (const v of members[c]!) compOf.set(files[v]!, c);
  }
  /** Components dispatched (in a batch out, or done). */
  const taken = new Set<number>();
  let completed = 0;
  let readyFiles = 0;
  for (const c of ready) readyFiles += members[c]!.length;

  return {
    components: n,
    largest: members.reduce((m, ms) => Math.max(m, ms.length), 0),
    depth: chain.reduce((m, h) => Math.max(m, h), 0),
    next(running) {
      if (ready.size === 0) return undefined;
      const free = Math.max(1, width - running);
      // The ready components are shared across the free slots…
      const share = Math.min(k, Math.ceil(readyFiles / free));
      const order = [...ready].sort((a, b) => weight[b]! - weight[a]! || a - b);
      const batch: string[] = [];
      const queue: number[] = [];
      const take = (c: number): void => {
        batch.push(...members[c]!.map((v) => files[v]!));
        taken.add(c);
        queue.push(c);
      };
      for (const c of order) {
        const size = members[c]!.length;
        if (batch.length > 0 && batch.length + size > share) continue;
        take(c);
        ready.delete(c);
        readyFiles -= size;
        if (batch.length >= share) break;
      }
      // …then the batch grows, up to k, along what waits on it: a component
      // whose every dependency is done or in this batch sees them as source.
      // Without it a batch is one level of the graph, and a run is at least
      // as many programs as the graph is deep (101 on this repo).
      const left = new Map<number, number>();
      for (let i = 0; i < queue.length && batch.length < k; i++) {
        for (const x of dependants[queue[i]!]!) {
          if (taken.has(x)) continue;
          const rem = (left.get(x) ?? waiting[x]!) - 1;
          left.set(x, rem);
          if (rem === 0 && batch.length + members[x]!.length <= k) take(x);
        }
      }
      return batch;
    },
    done(batch) {
      const comps = new Set<number>();
      for (const p of batch) {
        const c = compOf.get(p);
        if (c === undefined) {
          throw new Error(`batch plan: ${p} finished and was never planned`);
        }
        comps.add(c);
      }
      for (const c of comps) {
        completed++;
        for (const x of dependants[c]!) {
          waiting[x]!--;
          if (waiting[x] === 0 && !taken.has(x)) {
            ready.add(x);
            readyFiles += members[x]!.length;
          }
        }
      }
    },
    finished: () => completed === n && taken.size === n,
  };
}
