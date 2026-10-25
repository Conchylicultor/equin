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
// A file OUTSIDE the set is served its stored `.d.ts`, and a `.d.ts` imports
// what its file imports: a batch loading it loads those too. So an import of
// an outside file is followed through it, to the files of the set it reaches
// through outside files only (an import the plan did not see otherwise: a
// file importing an unchanged barrel over a changed file).
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
  /**
   * The files `p` imports — of `files`, or outside them (served, and followed
   * through to what they import). Asked of outside files too.
   */
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
  const reach = throughServed(index, input.deps);
  const globals = [...new Set([...input.globals].flatMap(reach))];
  const out: number[][] = files.map((p, i) => {
    const seen = new Set<number>(globals);
    for (const d of input.deps(p)) for (const j of reach(d)) seen.add(j);
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
    for (const j of reach(p)) envStack.push(comp[j]!);
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

/**
 * The files of the set a file stands for as an import: itself, when in the
 * set; else (served) every file of the set its imports reach through outside
 * files only. Memoized per strongly-connected component of the outside files
 * (an outside import cycle is followed once).
 */
function throughServed(
  index: ReadonlyMap<string, number>,
  deps: (p: string) => Iterable<string>,
): (p: string) => readonly number[] {
  const outsideId = new Map<string, number>();
  const outsidePath: string[] = [];
  const outsideDeps: string[][] = [];
  const idOf = (p: string): number => {
    let id = outsideId.get(p);
    if (id === undefined) {
      id = outsidePath.length;
      outsideId.set(p, id);
      outsidePath.push(p);
      outsideDeps.push([...deps(p)]);
    }
    return id;
  };
  /** Each outside file's frontier in the set, once its component is visited. */
  const frontier: (readonly number[] | undefined)[] = [];
  return (p) => {
    const j = index.get(p);
    if (j !== undefined) return [j];
    const start = idOf(p);
    const known = frontier[start];
    if (known !== undefined) return known;
    // The outside files `p` reaches, not yet resolved, found before Tarjan
    // runs over them (it needs its node set up front).
    const nodes: number[] = [];
    const queued = new Set<number>([start]);
    for (const stack = [start]; stack.length > 0;) {
      const v = stack.pop()!;
      nodes.push(v);
      for (const d of outsideDeps[v]!) {
        if (index.has(d)) continue;
        const w = idOf(d);
        if (frontier[w] !== undefined || queued.has(w)) continue;
        queued.add(w);
        stack.push(w);
      }
    }
    const edges = (v: number): number[] =>
      outsideDeps[v]!.filter((d) => !index.has(d)).map((d) =>
        outsideId.get(d)!,
      );
    forEachComponent(nodes, edges, (members) => {
      // Visited after every component it reaches: theirs are resolved.
      const inSet = new Set<number>();
      const own = new Set(members);
      for (const v of members) {
        for (const d of outsideDeps[v]!) {
          const k = index.get(d);
          if (k !== undefined) inSet.add(k);
          else {
            const w = outsideId.get(d)!;
            if (!own.has(w)) for (const x of frontier[w]!) inSet.add(x);
          }
        }
      }
      const f = [...inSet].sort((a, b) => a - b);
      for (const v of members) frontier[v] = f;
    });
    return frontier[start]!;
  };
}
