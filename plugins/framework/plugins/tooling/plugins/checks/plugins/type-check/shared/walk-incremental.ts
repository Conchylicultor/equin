// THE INCREMENTAL WALK's half outside the walk itself: which files it must
// visit (the dirty set D), how every other source file looks to it (FIXED, as
// the walk base ended — `./walk-base.ts`), and how D grows while meanings move
// (research/2026-10-21-global-type-check-prepare-follows-the-change.md,
// Stage C).
//
//   D₀ — the sources whose version moved or that are new, the readers of every
//        file that left the tree or of a non-source file that changed (a JSON
//        module: its meaning is its version), and the files whose resolution
//        probed a directory whose listing moved or read a file that moved —
//        each pulled in with its whole COMPONENT, so a cycle of names is
//        always hashed together, as the full walk hashes it.
//   growth — after each phase, every key a walked file owns whose meaning is
//        not the base's pulls in its readers (the base's reverse read-set)
//        and their components. After phase 0 only a DEFINITE new meaning
//        counts (a program-1 file's ⊥ waits for program 1, so a body edit
//        stops at the file); after phase 1 ⊥ counts too: a name that may move
//        in program 2 must have its readers walked before program 2 is sized.
//   order — the walked components go in RANK order (`order`): a walked file
//        that reaches another only through fixed files still comes after it,
//        and a new edge that could close a cycle through a fixed file throws
//        `WalkFallback` — the run walks every file instead.
//
// What a fixed file is to the walk: its names' base meanings (`rec`), its
// base rank, its base uses (to tell whether it read a stale `.d.ts`,
// `staleProbe`). Its result key and result are the base's; nothing of it is
// read from the name store.

import { splitKey } from "./name-records";
import {
  WalkFallback,
  WalkGrow,
  type FixedFiles,
  type FixedRec,
} from "./name-walk";
import type { RepoView } from "./repo-view";
import { listingHash } from "./run-base";
import type { Listings, WalkBase } from "./walk-base";

/** What moved between the base's tree and this one, and the dirty set it makes. */
export interface DirtyPlan {
  /** Sources new since the base, or whose version moved. */
  changed: Set<string>;
  /** Source files of the base that are not sources any more. */
  removed: string[];
  /** Files in D₀ because their resolution probed a directory, or read a file, that moved. */
  probed: Set<string>;
  /** D₀: whole components. */
  d0: Set<string>;
  /** How many paths of any kind were added, removed, modified; how many directories' listings moved. */
  paths: { added: number; removed: number; modified: number; dirs: number };
}

const parentOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

/**
 * Diff the tree against the base's — only in the shards whose listing hash
 * moved — and gather D₀.
 */
export function planDirty(
  base: WalkBase,
  view: RepoView,
  sources: ReadonlySet<string>,
  listings: Listings,
): DirtyPlan {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const ids = new Set([
    ...listings.hash.keys(),
    ...Object.keys(base.root.shards),
  ]);
  const empty = listingHash([]);
  for (const id of ids) {
    const now = listings.hash.get(id) ?? empty;
    const ref = base.root.shards[id];
    if ((ref?.[1] ?? empty) === now) continue;
    const before = ref === undefined ? {} : base.shard(id).p;
    for (const p of listings.paths.get(id) ?? []) {
      const b = before[p];
      if (b === undefined) added.push(p);
      else if (b !== view.version(p)) modified.push(p);
    }
    for (const p of Object.keys(before)) {
      if (view.version(p) === undefined) removed.push(p);
    }
  }

  // Directories whose LISTING moved: the parent of every added or removed
  // path, and up from there while the directory itself appeared or went.
  const addedSet = new Set(added);
  const removedDirs = new Set<string>();
  for (const p of removed) {
    for (let d = parentOf(p); ; d = parentOf(d)) {
      if (removedDirs.has(d)) break;
      removedDirs.add(d);
      if (d === "") break;
    }
  }
  const anyKept = new Map<string, boolean>();
  /** Whether `dir` holds, now, a file that is not new (so it existed before). */
  const holdsKept = (dir: string): boolean => {
    const hit = anyKept.get(dir);
    if (hit !== undefined) return hit;
    const e = view.entries(dir);
    let out = e.files.some(
      (f) => !addedSet.has(dir === "" ? f : `${dir}/${f}`),
    );
    for (let i = 0; !out && i < e.dirs.length; i++) {
      out = holdsKept(dir === "" ? e.dirs[i]! : `${dir}/${e.dirs[i]!}`);
    }
    anyKept.set(dir, out);
    return out;
  };
  const dirs = new Set<string>();
  for (const p of added) {
    let d = parentOf(p);
    dirs.add(d);
    // `d` is new when nothing in it predates this tree.
    while (d !== "" && !removedDirs.has(d) && !holdsKept(d)) {
      d = parentOf(d);
      dirs.add(d);
    }
  }
  for (const p of removed) {
    let d = parentOf(p);
    dirs.add(d);
    while (d !== "" && !view.isDir(d)) {
      d = parentOf(d);
      dirs.add(d);
    }
  }

  const d0 = new Set<string>();
  const probed = new Set<string>();
  const changed = new Set<string>();
  for (const p of [...added, ...modified]) {
    if (sources.has(p)) {
      d0.add(p);
      changed.add(p);
    }
  }
  const take = (x: string, into: Set<string>): void => {
    if (sources.has(x)) into.add(x);
  };
  // Readers of what left, and of a non-source file that changed: their reads
  // of it mean something else now, and nothing walked can say so.
  for (const p of [...removed, ...modified]) {
    if (sources.has(p)) continue;
    for (const [, , readers] of base.incoming(p)) {
      for (const x of readers) take(x, d0);
    }
  }
  for (const p of [...added, ...removed, ...modified]) {
    for (const x of base.fileReaders(p)) take(x, probed);
  }
  for (const d of dirs) {
    for (const x of base.dirReaders(d)) take(x, probed);
  }
  for (const x of probed) d0.add(x);
  for (const p of [...d0]) {
    for (const m of base.members(p)) take(m, d0);
  }
  return {
    changed,
    removed: removed.filter((p) => base.file(p) !== undefined),
    probed,
    d0,
    paths: {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      dirs: dirs.size,
    },
  };
}

/**
 * The fixed files, as the walk asks about them (`FixedFiles`), over the live
 * set of walked files — it grows while the walk expands.
 */
export class FixedView implements FixedFiles {
  /** Each walked file's rank, as the last `order` placed it. */
  ranks = new Map<string, number>();
  /** Wall ms spent answering the walk, by question (the walk line's split). */
  readonly ms = { rec: 0, order: 0, stale: 0, grow: 0 };
  /** The walked files' components, as the last `order` placed them. */
  comps: string[][] = [];

  constructor(
    private readonly base: WalkBase,
    private readonly walked: ReadonlyMap<string, unknown>,
    private readonly sources: ReadonlySet<string>,
  ) {}

  private fixedRank(p: string): number {
    const f = this.base.file(p);
    if (f === undefined) {
      throw new Error(
        `type-check: ${p} is a source file the walk did not visit, and the walk base has no state for it`,
      );
    }
    return f.o;
  }

  rec(path: string): FixedRec | undefined {
    const t0 = performance.now();
    try {
      return this.recOf(path);
    } finally {
      this.ms.rec += performance.now() - t0;
    }
  }

  private recOf(path: string): FixedRec | undefined {
    if (!this.sources.has(path) || this.walked.has(path)) return undefined;
    const f = this.base.file(path);
    if (f === undefined) {
      throw new Error(
        `type-check: ${path} is a source file the walk did not visit, and the walk base has no state for it`,
      );
    }
    return {
      m: Object.fromEntries(Object.entries(f.n).map(([n, [m]]) => [n, m])),
      star: f.x ?? [],
    };
  }

  /** Every source file reading a file in the base, lowest rank first (read once per run). */
  private readonly readerRanks = new Map<string, [number, string][]>();

  /** The lowest rank of a fixed file reading `p` (Infinity: none). */
  private lowestFixedReader(p: string): number {
    let list = this.readerRanks.get(p);
    if (list === undefined) {
      const seen = new Set<string>();
      list = [];
      for (const [, , readers] of this.base.incoming(p)) {
        for (const x of readers) {
          if (seen.has(x) || !this.sources.has(x)) continue;
          seen.add(x);
          const f = this.base.file(x);
          // A reader new since the base is walked, and has no base rank.
          if (f !== undefined) list.push([f.o, x]);
        }
      }
      list.sort((a, b) => a[0] - b[0]);
      this.readerRanks.set(p, list);
    }
    for (const [r, x] of list) if (!this.walked.has(x)) return r;
    return Infinity;
  }

  /** The fixed source files reading a file (through any key of it). */
  private fixedReaders(p: string): string[] {
    const out: string[] = [];
    for (const [, , readers] of this.base.incoming(p)) {
      for (const x of readers) {
        if (!this.walked.has(x) && this.sources.has(x)) out.push(x);
      }
    }
    return out;
  }

  /**
   * Place the walked components in RANK order (`FixedFiles.order`). A
   * component keeps its base rank while that is still above everything it
   * reads and below everything that reads it; else it is placed between the
   * two, its upper bound being the lowest fixed reader of it or — propagated
   * down — of any walked file above it, the gap shared out by the length of
   * the walked chain above it, so a chain never runs out of room. When the
   * bounds cross, the fixed files in the way are every fixed file that reads
   * it, at any depth, ranked at or below what it now reads (the region a
   * dynamic topological order reorders, Pearce–Kelly): all of them are walked
   * (`WalkGrow`) — one round — and a cycle through them merges.
   */
  order(
    comps: string[][],
    outOf: (path: string) => readonly string[],
  ): string[][] {
    const t0 = performance.now();
    try {
      return this.place(comps, outOf);
    } finally {
      this.ms.order += performance.now() - t0;
    }
  }

  private place(
    comps: string[][],
    outOf: (path: string) => readonly string[],
  ): string[][] {
    const compOf = new Map<string, number>();
    comps.forEach((members, i) => {
      for (const p of members) compOf.set(p, i);
    });
    // Walked edges between components, both ways.
    const below: Set<number>[] = comps.map(() => new Set());
    const above: Set<number>[] = comps.map(() => new Set());
    const fixedBelow: number[] = comps.map(() => -Infinity);
    comps.forEach((members, i) => {
      for (const p of members) {
        for (const o of outOf(p)) {
          const c = compOf.get(o);
          if (c === i) continue;
          if (c !== undefined) {
            below[i]!.add(c);
            above[c]!.add(i);
          } else if (this.walked.has(o)) {
            throw new Error(
              `type-check: ${p} reaches walked file ${o} outside the walked components`,
            );
          } else if (this.sources.has(o)) {
            fixedBelow[i] = Math.max(fixedBelow[i]!, this.fixedRank(o));
          }
        }
      }
    });
    // Upper bounds and chain lengths, from the top (comps are dependencies
    // first, so walk them backwards).
    const hi: number[] = comps.map(() => Infinity);
    const depth: number[] = comps.map(() => 0);
    for (let i = comps.length - 1; i >= 0; i--) {
      let h = Infinity;
      for (const p of comps[i]!) h = Math.min(h, this.lowestFixedReader(p));
      let d = 0;
      for (const a of above[i]!) {
        h = Math.min(h, hi[a]!);
        d = Math.max(d, depth[a]! + 1);
      }
      hi[i] = h;
      depth[i] = d;
    }
    const ranks = new Map<string, number>();
    const compRank: number[] = [];
    const blocked = new Set<number>();
    comps.forEach((members, i) => {
      let lo = fixedBelow[i]!;
      for (const b of below[i]!) lo = Math.max(lo, compRank[b]!);
      let cand = Infinity;
      for (const p of members) {
        const b = this.base.file(p);
        if (b !== undefined) cand = Math.min(cand, b.o);
      }
      const h = hi[i]!;
      let rank: number;
      if (cand !== Infinity && cand > lo && cand < h) rank = cand;
      else if (h === Infinity) rank = lo === -Infinity ? 0 : lo + 1;
      else if (lo === -Infinity) rank = h - 1 - depth[i]!;
      else rank = lo + (h - lo) / (depth[i]! + 2);
      if (!(rank > lo && rank < h)) {
        blocked.add(i);
        rank = lo === -Infinity ? 0 : lo + 1; // provisional, for what is above
      }
      compRank[i] = rank;
      for (const p of members) ranks.set(p, rank);
    });
    if (blocked.size > 0) {
      // The region in the way: every fixed file reading a blocked component
      // — directly, through walked files above it, or through each other —
      // ranked at or below the rank it must rise above.
      const region = new Set<string>();
      const queue: [string, number][] = [];
      const seenWalked = new Set<number>();
      const visitComp = (c: number, floor: number): void => {
        if (seenWalked.has(c)) return;
        seenWalked.add(c);
        for (const p of comps[c]!) queue.push([p, floor]);
        for (const a of above[c]!) visitComp(a, floor);
      };
      for (const c of blocked) {
        let lo = fixedBelow[c]!;
        for (const b of below[c]!) lo = Math.max(lo, compRank[b]!);
        visitComp(c, lo);
      }
      while (queue.length > 0) {
        const [p, floor] = queue.pop()!;
        for (const x of this.fixedReaders(p)) {
          if (region.has(x) || this.fixedRank(x) > floor) continue;
          region.add(x);
          queue.push([x, floor]);
        }
      }
      if (region.size === 0) {
        // Only floating point is in the way (ranks halved too often): the
        // full walk ranks every file afresh.
        throw new WalkFallback(
          `rank: no room left between ranks for ${[...blocked].map((c) => comps[c]![0]).join(", ")}`,
        );
      }
      throw new WalkGrow([...region].sort());
    }
    const sorted = comps
      .map((c, i) => [c, compRank[i]!, i] as const)
      .sort((a, b) => a[1] - b[1] || a[2] - b[2])
      .map(([c]) => c);
    this.ranks = ranks;
    this.comps = sorted;
    return sorted;
  }

  /**
   * Whether a fixed file uses — through fixed files — a stale walked one: the
   * REVERSE closure of each walked file as it turns up in `stale`, through
   * the fixed files whose uses name it (each fixed file entered once per
   * phase), pruned above the highest walked rank — an owner a walked file
   * asks about ranks below it. Exactly the forward question ("does it reach
   * one?"), answered without re-exploring a closure per owner.
   */
  staleProbe(): (owner: string, stale: ReadonlySet<string>) => boolean {
    const reach = new Set<string>();
    const done = new Set<string>();
    const probe = (owner: string, stale: ReadonlySet<string>): boolean => {
      let top = -Infinity;
      for (const r of this.ranks.values()) top = Math.max(top, r);
      for (const s of stale) {
        if (done.has(s) || !this.walked.has(s)) continue;
        done.add(s);
        const queue = [s];
        while (queue.length > 0) {
          const t = queue.pop()!;
          for (const [, , readers] of this.base.incoming(t)) {
            for (const x of readers) {
              if (reach.has(x) || this.walked.has(x) || !this.sources.has(x)) {
                continue;
              }
              const f = this.base.file(x);
              if (f === undefined || f.o > top) continue;
              if (!f.u.some((k) => splitKey(k)[0] === t)) continue;
              reach.add(x);
              queue.push(x);
            }
          }
        }
      }
      return reach.has(owner);
    };
    return (owner, stale) => {
      const t0 = performance.now();
      try {
        return probe(owner, stale);
      } finally {
        this.ms.stale += performance.now() - t0;
      }
    };
  }

  /**
   * The readers to walk next: of every key a walked file owns whose meaning
   * (`meaning`) is not the base's — a ⊥ or unknown one only when `bottom` —
   * each with its component.
   */
  grow(
    meaning: (key: string) => string | null | undefined,
    bottom: boolean,
  ): string[] {
    const t0 = performance.now();
    try {
      return this.readersToWalk(meaning, bottom);
    } finally {
      this.ms.grow += performance.now() - t0;
    }
  }

  private readersToWalk(
    meaning: (key: string) => string | null | undefined,
    bottom: boolean,
  ): string[] {
    const out = new Set<string>();
    for (const p of this.walked.keys()) {
      if (this.base.file(p) === undefined) continue;
      for (const [k, m, readers] of this.base.incoming(p)) {
        const v = meaning(k);
        if (v === m) continue;
        if (!bottom && (v === null || v === undefined)) continue;
        for (const x of readers) {
          if (this.walked.has(x) || !this.sources.has(x)) continue;
          for (const y of this.base.members(x)) {
            if (!this.walked.has(y) && this.sources.has(y)) out.add(y);
          }
        }
      }
    }
    return [...out].sort();
  }
}
