// The WALK BASE: the state the type check's walk (`./name-walk.ts`) ended in,
// content-addressed per tree, so the next run's walk visits only what changed
// and what a changed meaning reaches — O(|D| + frontier), not O(repo)
// (research/2026-10-21-global-type-check-prepare-follows-the-change.md,
// Stage C).
//
// Without it every run read 12.6k name-record entries and walked every file,
// on a tree where one file moved. With it a run reads the entries of the files
// it walks (`./walk-incremental.ts`) and treats every other source file as
// FIXED: its names mean what the base says, its result key and result are the
// base's.
//
//   - the ROOT, one per checked tree (pointer `tree → root hash`), holds the
//     global hash its state is valid under (`./name-run.ts`: the engine, every
//     global file, every repo `.d.ts`) and the global files themselves, plus
//     per SHARD id its content hash, the hash of its LISTING (every file of
//     the view in that shard, source or not, with its version), whether it
//     holds a diagnostic, and the day it was last marked used;
//   - a SHARD is one leaf plugin (`shardOf`, as the run base's):
//       `p`  every view file of the shard → its version (the listing itself:
//            what a later run diffs its tree against, in the shards whose
//            listing hash moved);
//       `f`  every source file → its walk state (`WalkFileState`): version,
//            result key R, the chosen result (contract hash, signature,
//            diagnostics), per name [meaning, text hash, name-use edges], star
//            targets, uses, every other key its key or its names read, its
//            resolution's probed directories and read files, its rank and
//            component;
//       `ir` every key OWNED by a file of the shard that some file reads →
//            [its meaning when the base ended, the readers] — the reverse
//            read-set, held by the target so "who reads this changed name" is
//            one shard read;
//       `id` every directory of the shard some resolution probed → the files
//            whose resolution probed it;
//       `if` every file of the shard some resolution read (a `package.json`)
//            → those files.
//
// A file's state is COMPLETE under the root's global hash: a later run whose
// global hash is the root's, on a file whose version and every read key's
// meaning are the base's, has this very R and result — exactly what the full
// walk would find (`incremental == full`, held by the replay oracle,
// `../scripts/walk-replay.ts`).
//
// Bounded like the run base: roots for a week, shards for two, a carried shard
// last marked used `TOUCH_AFTER_DAYS` ago touched — and with it the records
// the name store holds for its files (entry, contract, prediction data), which
// a fixed file never reads and would otherwise age out.

import { z } from "zod";
import { walkBaseRootsDir, walkBaseShardsDir } from "../data-dirs";
import { sha256 } from "./keys";
import { splitKey } from "./name-records";
import { openPassSet, type PassSetBounds } from "./pass-set";
import type { RepoView } from "./repo-view";
import { dayNumber, listingHash, shardOf, TOUCH_AFTER_DAYS } from "./run-base";
import { forEachComponent } from "./keys";
import { engineSources, sourcesFp } from "./tsc-engine";

/** Bump when the meaning of a stored root or shard changes (its key would not). */
export const WALK_BASE_FORMAT = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

const ROOT_BOUNDS: PassSetBounds = {
  maxAgeMs: 7 * DAY_MS,
  maxEntries: 3000,
  trimTo: 2400,
  pruneIntervalMs: 60 * 60 * 1000,
};

const SHARD_BOUNDS: PassSetBounds = {
  maxAgeMs: 14 * DAY_MS,
  maxEntries: 200000,
  trimTo: 160000,
  pruneIntervalMs: 60 * 60 * 1000,
};

/** One source file's walk state. Optional fields are absent when empty. */
export const walkFileSchema = z.object({
  /** Version: the git blob sha. */
  v: z.string(),
  /** Present (1) when the file is global (its version is in the global hash). */
  g: z.literal(1).optional(),
  /** Its result key R. */
  r: z.string(),
  /** The hash of its raw `.d.ts` (what importers are served). */
  c: z.string(),
  /** Its signature. */
  s: z.string(),
  /** Its diagnostics, when any. */
  e: z.array(z.string()).optional(),
  /** Each exported name → [meaning, canonical text hash, name-use edges]. */
  n: z.record(z.tuple([z.string(), z.string(), z.array(z.string())])),
  /** Its star re-export targets. */
  x: z.array(z.string()).optional(),
  /** What its source uses (name keys). */
  u: z.array(z.string()),
  /** Every other key its result key or its names' meanings read (star recursion, name-use edges). */
  k: z.array(z.string()).optional(),
  /** Its resolution's probed directories, and read files. */
  pd: z.array(z.string()).optional(),
  pf: z.array(z.string()).optional(),
  /** Its rank: above everything it reads, below everything that reads it (equal within a component). */
  o: z.number(),
  /** Its component's representative (the least member path), when that is another file. */
  m: z.string().optional(),
  /** On a multi-file component's representative: every member. */
  w: z.array(z.string()).optional(),
});

export type WalkFileState = z.infer<typeof walkFileSchema>;

const shardSchema = z.object({
  p: z.record(z.string()),
  f: z.record(walkFileSchema),
  ir: z.record(z.tuple([z.string(), z.array(z.string())])),
  id: z.record(z.array(z.string())),
  if: z.record(z.array(z.string())),
});

export type WalkShard = z.infer<typeof shardSchema>;

/**
 * A stored shard, read. Its SHAPE is checked (five records, each file's state
 * an object with a version, a key and a rank), not every field: a shard is
 * written whole by `putShard` and renamed into place, and a walk reads
 * hundreds of them — the full schema parse was most of what reading one cost
 * (measured: ~250 ms of a 600 ms walk). A shape this rejects is a bug here,
 * surfaced; `shardSchema` stays the definition of what is written.
 */
function shardOfRaw(raw: unknown, hash: string): WalkShard {
  const bad = (why: string): never => {
    throw new Error(`type-check: walk base shard ${hash} is malformed: ${why}`);
  };
  if (typeof raw !== "object" || raw === null) return bad("not an object");
  const r = raw as Record<string, unknown>;
  for (const k of ["p", "f", "ir", "id", "if"]) {
    if (typeof r[k] !== "object" || r[k] === null) bad(`no "${k}" record`);
  }
  for (const [path, f] of Object.entries(r.f as Record<string, unknown>)) {
    const st = f as Partial<WalkFileState> | null;
    if (
      st === null ||
      typeof st.v !== "string" ||
      typeof st.r !== "string" ||
      typeof st.o !== "number" ||
      typeof st.n !== "object" ||
      !Array.isArray(st.u)
    ) {
      bad(`file ${path}'s state`);
    }
  }
  return raw as WalkShard;
}

/** A shard's line in a root: [content hash, listing hash, holds a diagnostic, day last marked used]. */
export type WalkShardRef = [string, string, 0 | 1, number];

const rootSchema = z.object({
  format: z.literal(WALK_BASE_FORMAT),
  treeHash: z.string(),
  global: z.string(),
  globals: z.array(z.string()),
  shards: z.record(
    z.tuple([
      z.string(),
      z.string(),
      z.union([z.literal(0), z.literal(1)]),
      z.number(),
    ]),
  ),
});

export type WalkRoot = z.infer<typeof rootSchema>;

const short = (s: string): string => sha256(s).slice(0, 24);

const sortedRecord = <T>(r: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.keys(r)
      .sort()
      .map((k) => [k, r[k]!]),
  );

function canonicalShard(s: WalkShard): WalkShard {
  return {
    p: sortedRecord(s.p),
    f: sortedRecord(s.f),
    ir: sortedRecord(s.ir),
    id: sortedRecord(s.id),
    if: sortedRecord(s.if),
  };
}

export const walkShardHash = (s: WalkShard): string =>
  short(JSON.stringify(canonicalShard(s)));

function canonicalRoot(r: WalkRoot): WalkRoot {
  return {
    format: r.format,
    treeHash: r.treeHash,
    global: r.global,
    globals: [...r.globals].sort(),
    shards: sortedRecord(r.shards),
  };
}

export const walkRootHash = (r: WalkRoot): string =>
  short(JSON.stringify(canonicalRoot(r)));

export interface WalkBaseStore {
  pointer(treeHash: string): string | undefined;
  setPointer(treeHash: string, root: string): void;
  root(hash: string): WalkRoot | undefined;
  putRoot(root: WalkRoot): { hash: string; wrote: boolean };
  hasShard(hash: string): boolean;
  shard(hash: string): WalkShard | undefined;
  putShard(shard: WalkShard): { hash: string; wrote: boolean };
  touchShard(hash: string): boolean;
  /** The tree this checkout's last completed walk ended on: a hint, never trusted. */
  hint(checkout: string): string | undefined;
  setHint(checkout: string, treeHash: string): void;
}

const pointerSchema = z.object({ root: z.string() });
const hintSchema = z.object({ treeHash: z.string() });

/** Open (and lazily create) the host-wide walk base store. */
export function openWalkBaseStore(): WalkBaseStore {
  const roots = openPassSet(walkBaseRootsDir, ROOT_BOUNDS);
  const shards = openPassSet(walkBaseShardsDir, SHARD_BOUNDS);
  // Under the walk code that wrote them: a base is the state THIS walk
  // ended in, so one written by other walk code is not found — the run walks
  // every file (cheap, no TypeScript) instead of re-checking any. The result
  // store is keyed by the producer alone (`tscEngineFp`).
  const ns = `${WALK_BASE_FORMAT}\0${sourcesFp(engineSources()).slice(0, 16)}`;
  const pointerKey = (t: string) => `tree\0${ns}\0${t}`;
  const rootKey = (h: string) => `root\0${ns}\0${h}`;
  const shardKey = (h: string) => `shard\0${ns}\0${h}`;
  const hintKey = (w: string) => `hint\0${ns}\0${w}`;
  // Every entry is written below and renamed into place whole: a shape a
  // schema rejects is a bug in this file, surfaced.
  return {
    pointer: (t) => {
      const raw = roots.read(pointerKey(t));
      return raw === undefined ? undefined : pointerSchema.parse(raw).root;
    },
    setPointer: (t, root) => roots.record(pointerKey(t), { root }),
    root: (h) => {
      const raw = roots.read(rootKey(h));
      return raw === undefined ? undefined : rootSchema.parse(raw);
    },
    putRoot(root) {
      const h = walkRootHash(root);
      if (roots.touch(rootKey(h))) return { hash: h, wrote: false };
      roots.record(rootKey(h), { ...canonicalRoot(root) });
      return { hash: h, wrote: true };
    },
    hasShard: (h) => shards.has(shardKey(h)),
    shard: (h) => {
      const raw = shards.read(shardKey(h));
      return raw === undefined ? undefined : shardOfRaw(raw, h);
    },
    putShard(shard) {
      const h = walkShardHash(shard);
      if (shards.touch(shardKey(h))) return { hash: h, wrote: false };
      shards.record(shardKey(h), { ...canonicalShard(shard) });
      return { hash: h, wrote: true };
    },
    touchShard: (h) => shards.touch(shardKey(h)),
    hint: (w) => {
      const raw = roots.read(hintKey(w));
      return raw === undefined ? undefined : hintSchema.parse(raw).treeHash;
    },
    setHint: (w, treeHash) => roots.record(hintKey(w), { treeHash }),
  };
}

/** A shard with nothing in it. */
export const emptyWalkShard = (): WalkShard => ({
  p: {},
  f: {},
  ir: {},
  id: {},
  if: {},
});

/** The shard a directory's probe index lives in: the one its files would. */
export const dirShard = (dir: string): string =>
  shardOf(dir === "" ? "_" : `${dir}/_`);

/** The shard a name key's reverse reads live in: its owner's. */
export const keyShard = (key: string): string => shardOf(splitKey(key)[0]);

/** Every file of the view, by shard, and each shard's listing hash. */
export interface Listings {
  paths: Map<string, string[]>;
  hash: Map<string, string>;
}

export function listingsOf(view: RepoView): Listings {
  const paths = new Map<string, string[]>();
  for (const p of view.files()) {
    const s = shardOf(p);
    let list = paths.get(s);
    if (list === undefined) paths.set(s, (list = []));
    list.push(p);
  }
  const hash = new Map<string, string>();
  for (const [s, list] of paths) {
    hash.set(s, listingHash(list.map((p) => [p, view.version(p)!] as const)));
  }
  return { paths, hash };
}

/**
 * A base, opened: its root, and its shards read on demand (each once). Every
 * shard the root names was checked stored when it was opened
 * (`openWalkBase`); one gone since is a store pruned under a running check,
 * and throws.
 */
export class WalkBase {
  private readonly shards = new Map<string, WalkShard>();
  private readonly owners = new Map<string, Map<string, string[]>>();
  constructor(
    readonly store: WalkBaseStore,
    readonly hash: string,
    readonly root: WalkRoot,
  ) {}

  /** How many shards were read. */
  get shardsRead(): number {
    return this.shards.size;
  }

  shard(id: string): WalkShard {
    let s = this.shards.get(id);
    if (s !== undefined) return s;
    const ref = this.root.shards[id];
    if (ref === undefined) s = emptyWalkShard();
    else {
      s = this.store.shard(ref[0]);
      if (s === undefined) {
        throw new Error(
          `type-check: the walk base ${this.hash}'s shard ${id} (${ref[0]}) is not stored (pruned under a running check?)`,
        );
      }
    }
    this.shards.set(id, s);
    return s;
  }

  file(path: string): WalkFileState | undefined {
    return this.shard(shardOf(path)).f[path];
  }

  /** Every key of `owner` some file reads: [key, its meaning, its readers]. */
  incoming(owner: string): [string, string, readonly string[]][] {
    const id = shardOf(owner);
    let index = this.owners.get(id);
    if (index === undefined) {
      index = new Map();
      for (const k of Object.keys(this.shard(id).ir)) {
        const o = splitKey(k)[0];
        const list = index.get(o);
        if (list === undefined) index.set(o, [k]);
        else list.push(k);
      }
      this.owners.set(id, index);
    }
    const ir = this.shard(id).ir;
    return (index.get(owner) ?? []).map((k) => [k, ir[k]![0], ir[k]![1]]);
  }

  /** The files whose resolution probed `dir`. */
  dirReaders(dir: string): readonly string[] {
    return this.shard(dirShard(dir)).id[dir] ?? [];
  }

  /** The files whose resolution read `path`. */
  fileReaders(path: string): readonly string[] {
    return this.shard(shardOf(path)).if[path] ?? [];
  }

  /** Every file of `path`'s component (itself, when alone). */
  members(path: string): readonly string[] {
    const f = this.file(path);
    if (f === undefined) return [path];
    const rep = f.m ?? path;
    if (rep === path) return f.w ?? [path];
    return this.file(rep)?.w ?? [path];
  }

  /** Every file's state, every shard read: the compare paths only. */
  allFiles(): Map<string, WalkFileState> {
    const out = new Map<string, WalkFileState>();
    for (const id of Object.keys(this.root.shards)) {
      for (const [p, f] of Object.entries(this.shard(id).f)) out.set(p, f);
    }
    return out;
  }

  /** The files of the shards the root marks as holding a diagnostic, with one. */
  diagnosed(): Map<string, WalkFileState> {
    const out = new Map<string, WalkFileState>();
    for (const [id, ref] of Object.entries(this.root.shards)) {
      if (ref[2] === 0) continue;
      for (const [p, f] of Object.entries(this.shard(id).f)) {
        if (f.e !== undefined) out.set(p, f);
      }
    }
    return out;
  }
}

/** A base to walk from, or why there is none. */
export type OpenedWalkBase =
  | { kind: "base"; base: WalkBase; label: string }
  | { kind: "none"; reason: string };

/**
 * The base recorded under `rootHash`, checked complete: every shard it names
 * is stored (a gap is the store's age or count bound, and the run takes the
 * full walk, saying why).
 */
export function openWalkBase(
  store: WalkBaseStore,
  rootHash: string,
  label: string,
): OpenedWalkBase {
  const root = store.root(rootHash);
  if (root === undefined) {
    return {
      kind: "none",
      reason: `${label}: root ${rootHash.slice(0, 12)} pruned, or written by other walk code`,
    };
  }
  const refs = Object.values(root.shards);
  const missing = refs.filter(([h]) => !store.hasShard(h)).length;
  if (missing > 0) {
    return {
      kind: "none",
      reason: `${label}: missing ${missing} of ${refs.length} shards`,
    };
  }
  return { kind: "base", base: new WalkBase(store, rootHash, root), label };
}

// ─── Components and ranks of a whole walk ──────────────────────────────────

/**
 * Every file's component and rank, from scratch: components of the read
 * graph (each file → the owners of what it reads), the rank of a component
 * one above the highest it reads (0 when it reads no source). What a full
 * walk records; an incremental one keeps these and places only what it
 * walked (`./walk-incremental.ts`).
 */
export function assignComponents(files: Map<string, WalkFileState>): void {
  const paths = [...files.keys()].sort();
  const idx = new Map(paths.map((p, i) => [p, i]));
  const edges: number[][] = paths.map((p) => {
    const f = files.get(p)!;
    const out = new Set<number>();
    for (const k of [...f.u, ...(f.k ?? [])]) {
      const i = idx.get(splitKey(k)[0]);
      if (i !== undefined && paths[i] !== p) out.add(i);
    }
    return [...out];
  });
  const rankOf = new Map<number, number>();
  forEachComponent(
    paths.map((_, i) => i),
    (v) => edges[v]!,
    (members) => {
      const inComp = new Set(members);
      let r = 0;
      for (const v of members) {
        for (const w of edges[v]!) {
          if (!inComp.has(w)) r = Math.max(r, rankOf.get(w)! + 1);
        }
      }
      const names = members.map((i) => paths[i]!).sort();
      const rep = names[0]!;
      for (const v of members) {
        rankOf.set(v, r);
        const f = files.get(paths[v]!)!;
        f.o = r;
        delete f.m;
        delete f.w;
        if (paths[v] !== rep) f.m = rep;
      }
      if (names.length > 1) files.get(rep)!.w = names;
    },
  );
}

// ─── Writing the next base ──────────────────────────────────────────────────

export interface WalkBaseWrite {
  store: WalkBaseStore;
  treeHash: string;
  /** The checkout whose hint is set. */
  checkout: string;
  global: string;
  globals: readonly string[];
  listings: Listings;
  view: RepoView;
  /** The base this run walked from (undefined: a full walk — every file is in `files`). */
  base: WalkBase | undefined;
  /** Every walked file's state, complete (rank and component included). */
  files: ReadonlyMap<string, WalkFileState>;
  /** Source files of the base that are not sources any more. */
  removed: readonly string[];
  /** The final meaning of a key a walked file reads or owns. */
  meaning(key: string): string;
  /** Keep the name store's records of a carried file alive (its shard is being touched). */
  touch(path: string, f: WalkFileState): void;
}

export interface WalkBaseWritten {
  hash: string;
  wrote: boolean;
  rebuilt: number;
  fresh: number;
  carried: number;
  touched: number;
}

const addTo = (rec: Record<string, string[]>, key: string, v: string): void => {
  const list = rec[key];
  if (list === undefined) rec[key] = [v];
  else if (!list.includes(v)) {
    list.push(v);
    list.sort();
  }
};

const dropFrom = (
  rec: Record<string, string[]>,
  key: string,
  v: string,
): void => {
  const list = rec[key];
  if (list === undefined) return;
  const i = list.indexOf(v);
  if (i < 0) return;
  list.splice(i, 1);
  if (list.length === 0) delete rec[key];
};

const readsOf = (f: WalkFileState | undefined): string[] =>
  f === undefined ? [] : [...f.u, ...(f.k ?? [])];

/**
 * Write the base this run ended in: from scratch after a full walk; after an
 * incremental one, the base's shards with the walked files' states and the
 * reverse indexes patched — only the shards that changed are rewritten.
 */
export function writeWalkBase(w: WalkBaseWrite): WalkBaseWritten {
  const { base, listings, view } = w;
  const work = new Map<string, WalkShard>();
  const at = (id: string): WalkShard => {
    let s = work.get(id);
    if (s === undefined) {
      s =
        base === undefined ? emptyWalkShard() : structuredClone(base.shard(id));
      work.set(id, s);
    }
    return s;
  };

  /** A shard as it stands: rewritten this run, or the base's (not copied). */
  const peek = (id: string): WalkShard =>
    work.get(id) ?? (base === undefined ? emptyWalkShard() : base.shard(id));

  // Copy-on-write: a shard is rewritten only when an entry in it changes, so
  // a walked file that reads a thousand owners rewrites only the owners
  // whose reverse index it joins or leaves.
  const dropReader = (k: string, p: string): void => {
    const e = peek(keyShard(k)).ir[k];
    if (e === undefined || !e[1].includes(p)) return;
    const ir = at(keyShard(k)).ir;
    const list = ir[k]![1];
    list.splice(list.indexOf(p), 1);
    if (list.length === 0) delete ir[k];
  };
  const addReader = (k: string, p: string, m: string): void => {
    const e = peek(keyShard(k)).ir[k];
    if (e !== undefined && e[0] === m && e[1].includes(p)) return;
    const ir = at(keyShard(k)).ir;
    const cur = ir[k];
    if (cur === undefined) ir[k] = [m, [p]];
    else {
      cur[0] = m;
      if (!cur[1].includes(p)) {
        cur[1].push(p);
        cur[1].sort();
      }
    }
  };
  const indexDiff = (
    before: readonly string[],
    after: readonly string[],
    shard: (x: string) => string,
    pick: (s: WalkShard) => Record<string, string[]>,
    p: string,
  ): void => {
    const b = new Set(before);
    const a = new Set(after);
    for (const x of b) if (!a.has(x)) dropFrom(pick(at(shard(x))), x, p);
    for (const x of a) {
      if (pick(peek(shard(x)))[x]?.includes(p) === true) continue;
      addTo(pick(at(shard(x))), x, p);
    }
  };

  if (base !== undefined) {
    for (const p of w.removed) {
      const old = base.file(p);
      for (const k of readsOf(old)) dropReader(k, p);
      indexDiff(old?.pd ?? [], [], dirShard, (s) => s.id, p);
      indexDiff(old?.pf ?? [], [], shardOf, (s) => s.if, p);
      delete at(shardOf(p)).f[p];
    }
  }
  for (const [p, f] of w.files) {
    const old = base?.file(p);
    if (old === undefined || JSON.stringify(old) !== JSON.stringify(f)) {
      at(shardOf(p)).f[p] = f;
    }
    const now = new Set(readsOf(f));
    for (const k of readsOf(old)) if (!now.has(k)) dropReader(k, p);
    for (const k of now) addReader(k, p, w.meaning(k));
    indexDiff(old?.pd ?? [], f.pd ?? [], dirShard, (s) => s.id, p);
    indexDiff(old?.pf ?? [], f.pf ?? [], shardOf, (s) => s.if, p);
  }
  // Every key a walked file owns now means its final meaning (to its fixed
  // readers too: the run checked they are unchanged — `frontier`).
  for (const p of w.files.keys()) {
    const id = shardOf(p);
    for (const [k, e] of Object.entries(peek(id).ir)) {
      if (splitKey(k)[0] !== p) continue;
      const m = w.meaning(k);
      if (e[0] !== m) at(id).ir[k]![0] = m;
    }
  }
  // Listings: every shard whose files moved.
  const ids = new Set<string>([
    ...listings.hash.keys(),
    ...Object.keys(base?.root.shards ?? {}),
  ]);
  for (const id of ids) {
    const now = listings.hash.get(id) ?? listingHash([]);
    if (base !== undefined && base.root.shards[id]?.[1] === now) continue;
    const s = at(id);
    s.p = Object.fromEntries(
      (listings.paths.get(id) ?? []).map((p) => [p, view.version(p)!]),
    );
  }

  const today = dayNumber();
  const refs: Record<string, WalkShardRef> = {};
  let rebuilt = 0;
  let fresh = 0;
  let carried = 0;
  let touched = 0;
  for (const id of new Set([...ids, ...work.keys()])) {
    const listing = listings.hash.get(id) ?? listingHash([]);
    const s = work.get(id);
    if (s === undefined) {
      const prev = base!.root.shards[id]!;
      carried++;
      if (today - prev[3] < TOUCH_AFTER_DAYS) {
        refs[id] = prev;
        continue;
      }
      // Mark it used — it, and the name store's records of its files, which
      // nothing reads while they stay fixed.
      if (!w.store.touchShard(prev[0])) {
        throw new Error(
          `type-check: walk base shard ${id} (${prev[0]}) vanished while the run carried it`,
        );
      }
      for (const [p, f] of Object.entries(base!.shard(id).f)) w.touch(p, f);
      touched++;
      refs[id] = [prev[0], prev[1], prev[2], today];
      continue;
    }
    const empty =
      Object.keys(s.p).length === 0 &&
      Object.keys(s.f).length === 0 &&
      Object.keys(s.ir).length === 0 &&
      Object.keys(s.id).length === 0 &&
      Object.keys(s.if).length === 0;
    if (empty) continue;
    const { hash, wrote } = w.store.putShard(s);
    rebuilt++;
    if (wrote) fresh++;
    refs[id] = [
      hash,
      listing,
      Object.values(s.f).some((f) => f.e !== undefined) ? 1 : 0,
      today,
    ];
  }
  const root: WalkRoot = {
    format: WALK_BASE_FORMAT,
    treeHash: w.treeHash,
    global: w.global,
    globals: [...w.globals].sort(),
    shards: refs,
  };
  const { hash, wrote } = w.store.putRoot(root);
  w.store.setPointer(w.treeHash, hash);
  w.store.setHint(w.checkout, w.treeHash);
  return { hash, wrote, rebuilt, fresh, carried, touched };
}
