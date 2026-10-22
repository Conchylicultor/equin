// THE TYPE CHECK: two programs sized by changed names. One run, at most two
// programs, both decided before they are built
// (research/2026-10-21-global-type-check-two-programs.md):
//
//   1. PROGRAM 1 — the files with no valid stored result (`./name-walk.ts`
//      phase 0), as source; every other repo source file is served as its
//      stored `.d.ts` (`./name-host.ts`).
//   2. THE AFFECTED SET, without TypeScript (phase 1): the files whose key
//      moved once program 1's records are known, and every file using a name
//      that can move.
//   3. PROGRAM 2 — the affected set as source (plus the files whose typed lint
//      must run and that no program holds), the rest as stored `.d.ts`.
//
// A global or engine change misses every key, so program 1 is the whole tree:
// one program, as before. Type-aware lint runs on each file in the last program
// holding it as source, keyed on the same result key (`LintHook`).
//
// THE WALK visits every source file — or, from a WALK BASE
// (`./walk-base.ts`, research/2026-10-21-global-type-check-prepare-follows-the-change.md
// Stage C), only the DIRTY set D: what changed since the base, grown while a
// meaning it owns moves (`./walk-incremental.ts`). Every other file is FIXED:
// its names mean what the base says, and its key and result are the base's.
// The full walk stays as the no-base path, and the fallback whenever the
// incremental one cannot answer as it would (`WalkFallback`: the global hash
// moved, a new edge could close a cycle through a fixed file).
//
// The store (`./name-store.ts`) is per file text, host-wide: a run writes only
// what it checked.

import { createHash } from "crypto";
import ts from "typescript";
// Through the barrel: the worker imports it the same way.
import type { TscPredictionMiss } from "../core";
import {
  declaresGlobals,
  declScope,
  fileImports,
  runProgram,
  usesOf,
  type AmbientModules,
  type CheckedFile,
  type DeclScope,
  type ProgramRun,
  type ProgramStats,
} from "./name-check";
import { contractHash, type SourceFileCache } from "./name-host";
import { nameKey, splitKey, type NameRec } from "./name-records";
import { ProbeFs, RecordingResolver, resolutionHolds } from "./name-resolve";
import {
  coldWriteThrough,
  MAX_VARIANTS,
  REFRESH_AFTER_MS,
  type FileEntry,
  type NameStore,
  type StoredVariant,
} from "./name-store";
import {
  finalKeys,
  phase0,
  phase1,
  WalkFallback,
  WalkGrow,
  type WalkFile,
  type WalkInput,
  type WalkVariant,
} from "./name-walk";
import { isRepoPath, needsContract } from "./keys";
import type { RepoView } from "./repo-view";
import {
  assignComponents,
  listingsOf,
  type Listings,
  type OpenedWalkBase,
  type WalkBase,
  type WalkFileState,
} from "./walk-base";
import { FixedView, planDirty, type DirtyPlan } from "./walk-incremental";

const sha = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Type-aware lint, run inside the programs (`./worker.ts`). */
export interface LintHook {
  /** Whether a file's typed lint must run under result key `r`. */
  wants(path: string, r: string): boolean;
  /** Lint `files` (sources of `program`), each under its result key. */
  run(program: ts.Program, files: { path: string; r: string }[]): Promise<void>;
  /** Forget every result run so far: the run starts again, under other keys. */
  discard(): void;
  /**
   * The files sent to be linted: each needs a result key, and a program
   * holding it when its typed lint must run — a fixed file too (an
   * incremental walk does not visit it).
   */
  jobs?: readonly string[];
}

/** A name program 2 found moved that the affected set predicted stable. */
export type PredictionMiss = TscPredictionMiss;

/**
 * The affected set missed something: names it predicted stable moved, so the
 * files using them were not re-checked. Thrown under `onMiss: "throw"`.
 */
export class PredictionMissed extends Error {
  constructor(readonly missed: readonly PredictionMiss[]) {
    super(
      `type-check: ${missed.length} name(s) predicted stable moved in program 2 — the affected set missed what depends on them: ${missed
        .slice(0, 10)
        .map((m) => `${m.file}#${m.name}`)
        .join(", ")}`,
    );
    this.name = "PredictionMissed";
  }
}

/**
 * A program needs a file's stored `.d.ts`, and the store no longer holds it
 * (aged out): the run starts again with that file re-checked.
 */
class ContractMissing extends Error {
  constructor(readonly path: string) {
    super(`type-check: the stored .d.ts of ${path} is gone`);
    this.name = "ContractMissing";
  }
}

export interface NameRunInput {
  /**
   * The repo as the check sees it (`./repo-view.ts`): every file's version
   * (its git blob sha), every in-repo existence question, every text read.
   */
  view: RepoView;
  options: ts.CompilerOptions;
  /** The tsconfig's include expansion, repo-relative. */
  roots: readonly string[];
  /** The engine: compiler, options, dependencies, this code (`tscEngineFp`). */
  engine: string;
  store: NameStore;
  cache: SourceFileCache;
  lint?: LintHook;
  /**
   * When a name predicted stable moves (a bug in the affected set): `throw`
   * (tests, dual mode — a miss is a failure there), or `whole` — check every
   * file in one program over a store read as empty, so the verdict and every
   * record are right, and say so in `report.missed`. A failed run records
   * nothing, so throwing in the check path would fail every later run alike.
   */
  onMiss: "throw" | "whole";
  /**
   * The walk base to walk from (`./walk-base.ts`), or why there is none —
   * then, or when the base cannot answer for this tree, every file is walked.
   */
  base?: OpenedWalkBase;
}

export interface NameResult {
  diagnostics: string[];
  signature: string;
}

/** What the walk was, for the transcript's walk line. */
export interface WalkReport {
  /** `incremental (<base>)`, or `full (<why>)`. */
  mode: string;
  /** Files in D₀, and in D once it stopped growing (every file, for a full walk). */
  d0: number;
  d: number;
  /** Phase runs (each growth of D re-runs its phase). */
  rounds: number;
  /** Name-record entries read, and walk base shards. */
  entries: number;
  shards: number;
  /** Wall ms of the walk's parts: each phase (all its rounds), and the fixed files' answers. */
  split: string;
  /** Base shards read by the end of each part: the plan, phase 0, phase 1, the final keys. */
  shardsBy: [number, number, number, number];
  /** What moved since the base: paths added, removed, modified; directory listings. */
  paths: DirtyPlan["paths"] | null;
}

export interface NameRunReport {
  files: number;
  /** Files in program 1, pending after phase 0, re-checked in program 2. */
  first: number;
  pending: number;
  second: number;
  /** Program-1 files that read a stale served `.d.ts` and were re-checked. */
  tainted: number;
  /** Re-checked because a name they use moved, or may move (⊥). */
  keyMoved: number;
  usesBottom: number;
  /** Files only linted in program 2. */
  lintOnly: number;
  /** Files whose resolutions moved (checked as changed), and whose key was refreshed. */
  moved: number;
  refreshed: number;
  p1: ProgramStats | null;
  p2: ProgramStats | null;
  /** Wall ms of each part. */
  ms: {
    versions: number;
    plan: number;
    reads: number;
    listings: number;
    walk: number;
    write: number;
  };
  /** Entries read, and resolutions re-recorded. */
  reads: number;
  walk: WalkReport;
  /**
   * Predicted-stable names that moved in program 2 (must be none): non-empty,
   * this run fell back to one whole program (`onMiss: "whole"`).
   */
  missed: PredictionMiss[];
}

/** One file's final state, as the comparison paths read it. */
export interface FileFinal {
  r: string;
  contract: string;
  signature: string;
  diagnostics: string[];
}

/** What the walk base this run ended in is made of (`writeWalkBase`). */
export interface WalkOutcome {
  /** The base walked from (undefined: a full walk — `files` holds every file). */
  base: WalkBase | undefined;
  /**
   * What the base holds under: the global hash and the ambient modules'
   * names (a fixed file's uses depend on both).
   */
  global: string;
  globals: string[];
  listings: Listings;
  /** Every walked file's state. */
  files: Map<string, WalkFileState>;
  /** Source files of the base that are sources no more. */
  removed: string[];
  /** The final meaning of a key a walked file reads or owns. */
  meaning(key: string): string;
  /** Every source file's final state, fixed ones read from the base (every shard). */
  all(): Map<string, FileFinal>;
}

export interface NameRunOutput {
  /**
   * The result of every file walked, and of every fixed file with a
   * diagnostic (a fixed file's result is the base's): what the verdict needs.
   */
  results: Map<string, NameResult>;
  /**
   * The result key of every file walked, every repo `.d.ts`, and every file
   * the lint hook named (`LintHook.jobs`); a fixed file's is the base's.
   */
  keys: Map<string, string>;
  /** Options and global diagnostics of the environment. */
  programDiagnostics: string[];
  /** The files checked this run (program 1 ∪ program 2), sorted. */
  checked: string[];
  report: NameRunReport;
  walk: WalkOutcome;
}

const toWalkVariant = (v: StoredVariant): WalkVariant => ({
  r: v.r,
  contract: v.contract,
  names: Object.fromEntries(
    Object.entries(v.names).map(([n, [t, d]]) => [n, { t, d, i: [] }]),
  ),
  star: v.star,
  depM: {},
});

/** A base file's result as a variant: what it carries when its entry is gone. */
const baseVariant = (b: WalkFileState): WalkVariant => ({
  r: b.r,
  contract: b.c,
  names: Object.fromEntries(
    Object.entries(b.n).map(([n, [, t, d]]) => [n, { t, d, i: [] }]),
  ),
  star: b.x ?? [],
  depM: {},
});

const toTuple = (n: NameRec): [string, string[]] => [n.t, n.d];

export async function runNameCheck(
  input: NameRunInput,
): Promise<NameRunOutput> {
  const { view } = input;
  const ms = { versions: 0, plan: 0, reads: 0, listings: 0, walk: 0, write: 0 };
  const t0 = performance.now();
  const sources = input.roots.filter(needsContract).sort();
  const sourceSet = new Set(sources);
  const declRoots = input.roots
    .filter((p) => isRepoPath(p) && !needsContract(p))
    .sort();
  const version = (p: string): string => {
    const v = view.version(p);
    if (v === undefined) {
      throw new Error(
        `type-check: ${p} is a root of the program and is not in the checked tree ${view.treeHash}`,
      );
    }
    return v;
  };
  const versions = new Map(sources.map((p) => [p, version(p)]));
  // What each repo `.d.ts` can reach: only a global one is in the global
  // hash; an ambient-module one is a use of the files whose specifiers it
  // matches (`ambientUses`); a module one, of the files importing its path.
  const declScopes = new Map<string, DeclScope>(
    declRoots
      .filter((d) => /\.d\.[mc]?ts$/.test(d))
      .map((d) => [d, declScope(view.readText(d), d)]),
  );
  const ambient: AmbientModules = new Map(
    [...declScopes].flatMap(([d, s]) =>
      s.kind === "ambient" ? [[d, s.patterns] as const] : [],
    ),
  );
  const listings = listingsOf(view);
  ms.versions = performance.now() - t0;

  const t1 = performance.now();
  let incremental:
    { base: WalkBase; label: string; plan: DirtyPlan } | undefined;
  let why: string;
  if (input.base === undefined) why = "no base";
  else if (input.base.kind === "none") why = input.base.reason;
  else {
    const { base, label } = input.base;
    incremental = {
      base,
      label,
      plan: planDirty(base, view, sourceSet, listings),
    };
    why = "";
  }
  ms.plan = performance.now() - t1;

  const demoted = new Set<string>();
  for (;;) {
    try {
      return await walkAndCheck({
        input,
        sources,
        sourceSet,
        declRoots,
        declScopes,
        ambient,
        versions,
        version,
        listings,
        incremental,
        fullWhy: why,
        demoted,
        ms,
      });
    } catch (err) {
      if (err instanceof ContractMissing) {
        // Re-check the file whose `.d.ts` aged out — and, in the same pass,
        // every other file whose stored `.d.ts` is gone, so the run starts
        // again once, not once per file: this attempt built nothing the next
        // one keeps.
        if (demoted.has(err.path)) throw err;
        demoted.add(err.path);
        for (const p of contractsGone(
          input.store,
          sources,
          versions,
          incremental?.base,
        )) {
          demoted.add(p);
        }
        input.lint?.discard();
        continue;
      }
      if (err instanceof WalkFallback && incremental !== undefined) {
        why = err.reason;
        incremental = undefined;
        input.lint?.discard();
        continue;
      }
      throw err;
    }
  }
}

/**
 * The source files whose stored `.d.ts` is gone (the store's age or count
 * bound): the walk base's for a file it holds this text of, else the newest
 * stored result's. Read only on the rare path where a program found one gone.
 */
function contractsGone(
  store: NameStore,
  sources: readonly string[],
  versions: ReadonlyMap<string, string>,
  base: WalkBase | undefined,
): string[] {
  const out: string[] = [];
  for (const p of sources) {
    const v = versions.get(p)!;
    const b = base?.file(p);
    const hash =
      b !== undefined && b.v === v
        ? b.c
        : store.readEntry(p, v)?.variants[0]?.contract;
    if (hash !== undefined && !store.hasContract(hash)) out.push(p);
  }
  return out;
}

interface Attempt {
  input: NameRunInput;
  sources: readonly string[];
  sourceSet: ReadonlySet<string>;
  declRoots: readonly string[];
  declScopes: ReadonlyMap<string, DeclScope>;
  ambient: AmbientModules;
  versions: ReadonlyMap<string, string>;
  version(p: string): string;
  listings: Listings;
  incremental: { base: WalkBase; label: string; plan: DirtyPlan } | undefined;
  fullWhy: string;
  /** Files whose stored `.d.ts` is gone: re-checked, whatever their entry says. */
  demoted: ReadonlySet<string>;
  ms: NameRunReport["ms"];
}

async function walkAndCheck(a: Attempt): Promise<NameRunOutput> {
  const {
    input,
    sources,
    sourceSet,
    declRoots,
    declScopes,
    ambient,
    versions,
    version,
    demoted,
  } = a;
  const { view, options, store, cache } = input;
  const ms = a.ms;
  ms.reads = ms.listings = ms.walk = ms.write = 0;
  let t = performance.now();
  const lap = (k: keyof typeof ms): void => {
    const now = performance.now();
    ms[k] += now - t;
    t = now;
  };
  const inc = a.incremental;
  const base = inc?.base;

  // ── The files walked: every source, or D ──
  /** The base's state of a file, when it holds this very text. */
  const baseOf = (p: string): WalkFileState | undefined => {
    if (base === undefined) return undefined;
    const b = base.file(p);
    return b !== undefined && b.v === versions.get(p) ? b : undefined;
  };
  const initial = new Set<string>(inc === undefined ? sources : inc.plan.d0);
  if (inc !== undefined) {
    for (const p of demoted) {
      for (const m of inc.base.members(p)) {
        if (sourceSet.has(m)) initial.add(m);
      }
      initial.add(p);
    }
  }

  // ── The stored entries, one per file text, read for walked files ──
  const entries = new Map<string, FileEntry | undefined>();
  let entriesRead = 0;
  const readEntry = (p: string): FileEntry | undefined => {
    if (!entries.has(p)) {
      entriesRead++;
      entries.set(p, store.readEntry(p, versions.get(p)!));
    }
    return entries.get(p);
  };
  for (const p of initial) readEntry(p);
  lap("reads");

  // ── The global hash: the engine, every global file, every repo `.d.ts` ──
  let globals: string[];
  if (inc === undefined) {
    globals = sources.filter((p) => {
      const e = entries.get(p);
      return e !== undefined ? e.global : declaresGlobals(view.readText(p), p);
    });
  } else {
    // The base's, but for the files that changed: what their entry (or
    // text) says now.
    const { changed } = inc.plan;
    const g = new Set(
      inc.base.root.globals.filter((p) => sourceSet.has(p) && !changed.has(p)),
    );
    for (const p of changed) {
      const e = entries.get(p);
      if (e !== undefined ? e.global : declaresGlobals(view.readText(p), p)) {
        g.add(p);
      }
    }
    globals = [...g].sort();
  }
  const global = sha(
    [
      `engine\0${input.engine}`,
      ...globals.map((p) => `global\0${p}\0${versions.get(p)}`),
      ...[...declScopes]
        .filter(([, s]) => s.kind === "global")
        .map(([p]) => `decl\0${p}\0${version(p)}`),
    ].join("\n"),
  );
  // The walk base holds under the global hash AND the ambient modules' names:
  // a file's uses include the ambient `.d.ts` its specifiers match, and a
  // fixed file's uses are the base's — so a name declared or dropped walks
  // every file (a `.d.ts`'s version alone moves only its readers' keys).
  const baseGlobal = sha(
    [
      global,
      ...[...ambient].map(([d, pats]) => `ambient\0${d}\0${pats.join("\0")}`),
    ].join("\n"),
  );
  if (inc !== undefined && inc.base.root.global !== baseGlobal) {
    throw new WalkFallback(
      "the global hash or the ambient module names moved since the base",
    );
  }

  // ── Resolutions: keyed on what they probed ──
  const fs = new ProbeFs(view);
  const resolver = new RecordingResolver(fs, options);
  let moved = 0;
  let refreshed = 0;
  const rewrite = new Set<string>();
  /** Files whose imports land elsewhere now: checked, whatever is stored. */
  const resMoved = new Set<string>();
  const checkResolution = (p: string): void => {
    const e = entries.get(p);
    if (e === undefined || resolutionHolds(fs, e.res)) return;
    const res = resolver.record(
      p,
      e.res.targets.map(([s, m]) => [s, m] as [string, number]),
    );
    if (JSON.stringify(res.targets) !== JSON.stringify(e.res.targets)) {
      entries.set(p, undefined); // its imports land elsewhere: check it
      resMoved.add(p);
      moved++;
    } else {
      e.res = res;
      rewrite.add(p);
      refreshed++;
    }
  };
  for (const p of initial) checkResolution(p);
  lap("listings");

  // ── The walk input ──
  /** A walked file as the walk sees it: its entry, or the base's state of its text. */
  const fileOf = (p: string): WalkFile => {
    const e = demoted.has(p) ? undefined : entries.get(p);
    const b = baseOf(p);
    if (e === undefined) {
      // No entry for this text (aged out): the base's state stands in, while
      // its resolution holds.
      if (
        b !== undefined &&
        !demoted.has(p) &&
        !resMoved.has(p) &&
        !inc!.plan.probed.has(p)
      ) {
        return {
          version: versions.get(p)!,
          uses: b.u,
          variants: [baseVariant(b)],
        };
      }
      return {
        version: versions.get(p)!,
        uses:
          demoted.has(p) && entries.get(p) !== undefined
            ? usesOf(
                entries.get(p)!.imports,
                entries.get(p)!.res.targets,
                ambient,
              )
            : undefined,
        variants: [],
      };
    }
    const variants = e.variants
      .filter((v) => v.global === global)
      .map(toWalkVariant);
    if (b !== undefined) {
      // The base's variant first: it is what fixed readers and served
      // programs saw of this file.
      const i = variants.findIndex((v) => v.r === b.r);
      if (i > 0) variants.unshift(...variants.splice(i, 1));
      else if (i < 0) variants.unshift(baseVariant(b));
    }
    return {
      version: versions.get(p)!,
      uses: usesOf(e.imports, e.res.targets, ambient),
      variants,
    };
  };
  const files = new Map<string, WalkFile>();
  for (const p of initial) files.set(p, fileOf(p));
  const fixed =
    inc === undefined ? undefined : new FixedView(inc.base, files, sourceSet);
  /** Walk `more` too: their entries, resolutions, and walk files. */
  const admit = (more: readonly string[]): void => {
    for (const p of more) readEntry(p);
    for (const p of more) checkResolution(p);
    for (const p of more) files.set(p, fileOf(p));
  };
  /**
   * Run a phase, walking the fixed readers that stand in the way of a
   * walked file's rank (`WalkGrow`) until it places every component.
   */
  const phaseMs = { phase0: 0, phase1: 0, final: 0, grows: 0 };
  const placed = <T>(phase: () => T): T => {
    for (;;) {
      try {
        return phase();
      } catch (err) {
        if (!(err instanceof WalkGrow)) throw err;
        const more = new Set<string>();
        for (const p of err.paths) {
          for (const m of base!.members(p)) {
            if (!files.has(m) && sourceSet.has(m)) more.add(m);
          }
        }
        if (more.size === 0) throw err;
        phaseMs.grows++;
        admit([...more].sort());
      }
    }
  };
  const walkInput: WalkInput = {
    files,
    global,
    declMeaning: (p) => view.version(p) ?? "-",
    detail: (_p, v) => store.readDetail(v.r),
    ...(fixed ? { fixed } : {}),
  };
  /** A walked file's stored result under `r` (its entry's, or the base's). */
  const storedResult = (p: string, r: string): NameResult => {
    const v = entries.get(p)?.variants.find((x) => x.r === r);
    if (v !== undefined) {
      return { diagnostics: v.diagnostics, signature: v.signature };
    }
    const b = baseOf(p);
    if (b !== undefined && b.r === r) {
      return { diagnostics: b.e ?? [], signature: b.s };
    }
    throw new Error(`type-check: ${p} has no stored result under key ${r}`);
  };
  const contractText = (p: string, hash: string): string => {
    const text = store.readContract(hash);
    if (text === undefined) throw new ContractMissing(p);
    return text;
  };
  /** A fixed file's stored `.d.ts`: the base's. */
  const fixedContract = (p: string): string => {
    if (!sourceSet.has(p)) {
      throw new Error(
        `type-check: ${p} is imported but is not a root of the program (outside the tsconfig include?)`,
      );
    }
    const b = base?.file(p);
    if (b === undefined) {
      throw new Error(
        `type-check: ${p} is neither walked nor in the walk base`,
      );
    }
    return contractText(p, b.c);
  };

  // ── Phase 0, growing D while a definite meaning moves ──
  let rounds = 0;
  const planShards = base?.shardsRead ?? 0;
  let tp = performance.now();
  let p0 = placed(() => phase0(walkInput));
  rounds++;
  while (fixed !== undefined) {
    const more = fixed.grow(p0.meaning, false);
    if (more.length === 0) break;
    admit(more);
    p0 = placed(() => phase0(walkInput));
    rounds++;
  }
  const p0Shards = base?.shardsRead ?? 0;
  phaseMs.phase0 = performance.now() - tp;
  lap("walk");

  const fresh = new Map<string, CheckedFile>();
  let programDiagnostics: string[] | undefined;
  const report: NameRunReport = {
    files: sources.length,
    first: p0.first.size,
    pending: p0.pending.size,
    second: 0,
    tainted: 0,
    keyMoved: 0,
    usesBottom: 0,
    lintOnly: 0,
    moved,
    refreshed,
    p1: null,
    p2: null,
    ms,
    reads: 0,
    walk: {
      mode:
        inc === undefined
          ? `full (${a.fullWhy})`
          : `incremental (${inc.label})`,
      d0: inc === undefined ? sources.length : inc.plan.d0.size,
      d: 0,
      rounds: 0,
      entries: 0,
      shards: 0,
      shardsBy: [planShards, p0Shards, 0, 0],
      split: "",
      paths: inc?.plan.paths ?? null,
    },
    missed: [],
  };

  // ── Program 1 ──
  let served = new Map<string, string>();
  let p1Run: ProgramRun | undefined;
  if (p0.first.size > 0) {
    p1Run = runProgram({
      view,
      options,
      sources: p0.first,
      check: p0.first,
      declRoots,
      globals,
      declScopes,
      ambient,
      contractOf: (p) => {
        const f = files.get(p);
        if (f === undefined) return fixedContract(p);
        const v = p0.valid.get(p) ?? f.variants[0];
        if (v === undefined) {
          throw new Error(
            `type-check: program 1 needs ${p}'s .d.ts, and none is stored`,
          );
        }
        return contractText(p, v.contract);
      },
      cache,
      resolver,
    });
    t = performance.now();
    report.p1 = p1Run.stats;
    served = p1Run.served;
    programDiagnostics = p1Run.programDiagnostics;
    for (const [p, c] of p1Run.checked) {
      if (c.global !== globals.includes(p)) {
        throw new Error(
          `type-check: ${p} is ${c.global ? "" : "not "}global to the checker, and its syntax says otherwise — declaresGlobals is missing a case`,
        );
      }
      fresh.set(p, c);
      files.set(p, {
        ...files.get(p)!,
        uses: c.uses,
        fresh: { names: c.names, star: c.star, depM: {} },
      });
    }
  }

  // ── Phase 1: the affected set, growing D while a meaning may move ──
  tp = performance.now();
  let p1 = placed(() => phase1(walkInput, p0.first, served));
  rounds++;
  while (fixed !== undefined) {
    const more = fixed.grow(p1.meaning, true);
    if (more.length === 0) break;
    admit(more);
    p1 = placed(() => phase1(walkInput, p0.first, served));
    rounds++;
  }
  lap("walk");
  report.walk.shardsBy[2] = base?.shardsRead ?? 0;
  phaseMs.phase1 = performance.now() - tp;
  report.second = p1.second.size;
  report.tainted = p1.tainted.size;
  report.keyMoved = [...p1.why.values()].filter((w) => w === "moved").length;
  report.usesBottom = [...p1.why.values()].filter((w) => w === "bottom").length;

  // Lint what program 1 holds and program 2 will not.
  if (p1Run !== undefined && input.lint) {
    const lintable = [...p1.confirmed]
      .filter(([p, r]) => input.lint!.wants(p, r))
      .map(([path, r]) => ({ path, r }));
    if (lintable.length > 0) await input.lint.run(p1Run.program, lintable);
    t = performance.now();
  }

  // ── Program 2 ──
  /** Files linted in program 2 without being checked, under their key. */
  const lintOnly = new Map<string, string>();
  if (input.lint) {
    for (const [p, v] of p1.valid) {
      if (!p1.second.has(p) && input.lint.wants(p, v.r)) lintOnly.set(p, v.r);
    }
    // A fixed file sent to be linted: its key is the base's.
    for (const p of input.lint.jobs ?? []) {
      if (files.has(p) || !sourceSet.has(p)) continue;
      const r = base!.file(p)!.r;
      if (input.lint.wants(p, r)) lintOnly.set(p, r);
    }
  }
  report.lintOnly = lintOnly.size;
  let p2Run: ProgramRun | undefined;
  const second = new Map<string, CheckedFile>();
  if (p1.second.size > 0 || lintOnly.size > 0) {
    p1Run = undefined; // program 1 is done: free it before program 2
    p2Run = runProgram({
      view,
      options,
      sources: new Set([...p1.second, ...lintOnly.keys()]),
      check: p1.second,
      declRoots,
      globals,
      declScopes,
      ambient,
      contractOf: (p) => {
        const f = fresh.get(p);
        if (f !== undefined && p1.confirmed.has(p)) return f.contract;
        if (!files.has(p)) return fixedContract(p);
        const v = p1.valid.get(p);
        if (v === undefined) {
          throw new Error(
            `type-check: program 2 needs ${p}'s .d.ts, which has no valid record`,
          );
        }
        return contractText(p, v.contract);
      },
      cache,
      resolver,
    });
    t = performance.now();
    report.p2 = p2Run.stats;
    programDiagnostics = p2Run.programDiagnostics;
    for (const [p, c] of p2Run.checked) {
      second.set(p, c);
      files.set(p, {
        ...files.get(p)!,
        uses: c.uses,
        fresh: { names: c.names, star: c.star, depM: {} },
      });
    }
  }

  /** A file's `.d.ts` at the end of the run: checked this run, valid, or fixed. */
  const finalContract = (p: string): string => {
    const c = second.get(p) ?? (p1.confirmed.has(p) ? fresh.get(p) : undefined);
    if (c !== undefined) return c.contract;
    if (!files.has(p)) return fixedContract(p);
    const v = p1.valid.get(p);
    if (v === undefined) {
      throw new Error(
        `type-check: ${p}'s .d.ts is needed and it has no record`,
      );
    }
    return contractText(p, v.contract);
  };

  // ── The final keys, and the self-checks ──
  const checked = new Set<string>([...p1.confirmed.keys(), ...p1.second]);
  const valid = new Map<string, WalkVariant>();
  for (const [p, v] of p1.valid) if (!checked.has(p)) valid.set(p, v);
  let fin: ReturnType<typeof finalKeys>;
  tp = performance.now();
  try {
    fin = finalKeys(walkInput, valid, checked);
  } catch (err) {
    // Program 2's records placed a file above a fixed reader: the programs
    // are built, too late to walk more.
    if (err instanceof WalkGrow) {
      throw new WalkFallback(`rank after program 2: ${err.message}`);
    }
    throw err;
  }
  phaseMs.final = performance.now() - tp;
  lap("walk");
  const missed: PredictionMiss[] = [];
  for (const [p, { prev, names }] of p1.stable) {
    const now = second.get(p)!.names;
    for (const n of names) {
      const a1 = prev.names[n]!;
      const b1 = now[n];
      if (
        b1 === undefined ||
        a1.t !== b1.t ||
        a1.d.join("\n") !== b1.d.join("\n")
      ) {
        missed.push({ file: p, name: n });
      }
    }
  }
  // A file kept valid whose key is not its variant's any more: a name it
  // uses moved after the walk judged it.
  for (const p of fin.mismatched)
    missed.push({ file: p, name: "(result key)" });
  // The FRONTIER: a fixed file reading a key a walked file owns, whose
  // meaning moved — D stopped growing too soon.
  if (fixed !== undefined) {
    for (const p of fixed.grow(fin.meaning, true)) {
      missed.push({ file: p, name: "(frontier: reads a meaning that moved)" });
    }
  }
  if (missed.length > 0) {
    if (input.onMiss === "throw") throw new PredictionMissed(missed);
    // Nothing of this run is recorded. A cold run cannot miss: it has no
    // program 2, and walks every file.
    p1Run = undefined;
    p2Run = undefined;
    input.lint?.discard();
    const whole = await runNameCheck({
      ...input,
      store: coldWriteThrough(store),
      onMiss: "throw",
      base: { kind: "none", reason: "a missed prediction" },
    });
    whole.report.missed = missed;
    return whole;
  }

  // ── Lint program 2 ──
  if (p2Run !== undefined && input.lint) {
    const lintable: { path: string; r: string }[] = [];
    for (const p of p1.second) {
      const r = fin.keys.get(p)!;
      if (input.lint.wants(p, r)) lintable.push({ path: p, r });
    }
    for (const [p, r] of lintOnly) lintable.push({ path: p, r });
    if (lintable.length > 0) await input.lint.run(p2Run.program, lintable);
    t = performance.now();
  }
  // ── The repo `.d.ts`: keyed on their imports' meanings ──
  // Every program holds them (they are roots of each), so their typed lint
  // runs in the last one built — or, when none was, in a program of the
  // environment alone.
  const declKeys = new Map<string, string>();
  for (const d of declRoots) {
    if (!/\.d\.[mc]?ts$/.test(d)) continue;
    const sf = ts.createSourceFile(
      d,
      view.readText(d),
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
    );
    const lines: string[] = [];
    for (const [spec, mode, name] of fileImports(sf, options)) {
      const target = resolver.target(d, spec, mode);
      if (name === "" || target === "-" || target === "<dep>") {
        lines.push(`${spec}\0${mode}\0${target}`);
        continue;
      }
      const m = fin.meaning(`${target}\0${name}`);
      if (m === undefined || m === null) {
        throw new Error(
          `type-check: ${d} imports ${target}#${name}, which has no meaning at the end of the run`,
        );
      }
      lines.push(`${spec}\0${mode}\0${target}\0${name}\0${m}`);
    }
    declKeys.set(
      d,
      sha(`decl\0${global}\0${d}\0${version(d)}\0${lines.sort().join("\n")}`),
    );
  }
  if (input.lint) {
    const lintable = [...declKeys]
      .filter(([p, r]) => input.lint!.wants(p, r))
      .map(([path, r]) => ({ path, r }));
    if (lintable.length > 0) {
      const holder =
        p2Run ??
        p1Run ??
        runProgram({
          view,
          options,
          sources: new Set(),
          check: new Set(),
          declRoots,
          globals,
          declScopes,
          ambient,
          contractOf: finalContract,
          cache,
          resolver,
        });
      await input.lint.run(holder.program, lintable);
      t = performance.now();
    }
  }
  p1Run = undefined;
  p2Run = undefined;

  const meaning = (k: string): string => {
    const m = fin.meaning(k);
    if (m === undefined || m === null) {
      throw new Error(
        `type-check: ${k.replace("\0", "#")} has no meaning at the end of the run`,
      );
    }
    return m;
  };

  // ── Record ──
  const results = new Map<string, NameResult>();
  const keys = new Map<string, string>();
  const states = new Map<string, WalkFileState>();
  const now = Date.now();
  for (const p of files.keys()) {
    const r = fin.keys.get(p)!;
    keys.set(p, r);
    const f = files.get(p)!;
    const c = second.get(p) ?? (p1.confirmed.has(p) ? fresh.get(p) : undefined);
    const e = entries.get(p);
    if (c !== undefined) {
      results.set(p, { diagnostics: c.diagnostics, signature: c.signature });
      const contract = contractHash(c.contract);
      store.writeContract(contract, c.contract);
      const variant: StoredVariant = {
        global,
        r,
        contract,
        signature: c.signature,
        diagnostics: c.diagnostics,
        names: Object.fromEntries(
          Object.entries(c.names).map(([n, rec]) => [n, toTuple(rec)]),
        ),
        star: c.star,
      };
      store.writeDetail(r, {
        i: Object.fromEntries(
          Object.entries(c.names).map(([n, rec]) => [n, rec.i]),
        ),
        depM: fin.depM.get(p)!,
      });
      store.writeEntry(p, versions.get(p)!, {
        global: c.global,
        imports: c.imports,
        res: c.res,
        variants: [
          variant,
          ...(e?.variants ?? []).filter((v) => v.r !== r),
        ].slice(0, MAX_VARIANTS),
      });
      states.set(
        p,
        stateOf(p, {
          version: versions.get(p)!,
          global: c.global,
          r,
          contract,
          result: results.get(p)!,
          names: c.names,
          star: c.star,
          uses: c.uses,
          reads: fin.reads.get(p)!,
          res: c.res,
          meaning,
        }),
      );
      continue;
    }
    const v = valid.get(p);
    if (v === undefined) {
      throw new Error(`type-check: ${p} was neither checked nor valid`);
    }
    const result = storedResult(p, v.r);
    results.set(p, result);
    // An entry in use is re-written when old, so the age bound means "unused".
    if (
      e !== undefined &&
      (rewrite.has(p) || now - (e.recordedAt ?? 0) > REFRESH_AFTER_MS)
    ) {
      store.writeEntry(p, versions.get(p)!, e);
    }
    const b = baseOf(p);
    states.set(
      p,
      stateOf(p, {
        version: versions.get(p)!,
        global: e !== undefined ? e.global : b?.g === 1,
        r: v.r,
        contract: v.contract,
        result,
        names: v.names,
        star: v.star,
        uses: f.uses ?? [],
        reads: fin.reads.get(p)!,
        res:
          e !== undefined ? e.res : { dirs: b?.pd ?? [], files: b?.pf ?? [] },
        meaning,
      }),
    );
  }
  // A fixed file's result is the base's: the verdict needs the ones with a
  // diagnostic, the lint the keys of the ones it was sent.
  if (base !== undefined) {
    for (const [p, b] of base.diagnosed()) {
      if (!files.has(p) && sourceSet.has(p)) {
        results.set(p, { diagnostics: b.e ?? [], signature: b.s });
      }
    }
    for (const p of input.lint?.jobs ?? []) {
      if (!files.has(p) && sourceSet.has(p)) keys.set(p, base.file(p)!.r);
    }
  }

  // ── Program-level diagnostics: from a program built now, or stored ──
  if (programDiagnostics !== undefined) {
    store.writeProgramDiagnostics(global, programDiagnostics);
  } else {
    programDiagnostics = store.readProgramDiagnostics(global);
    if (programDiagnostics === undefined) {
      const empty = runProgram({
        view,
        options,
        sources: new Set(),
        check: new Set(),
        declRoots,
        globals,
        declScopes,
        ambient,
        contractOf: finalContract,
        cache,
        resolver,
      });
      programDiagnostics = empty.programDiagnostics;
      store.writeProgramDiagnostics(global, programDiagnostics);
    }
    t = performance.now();
  }
  for (const [d, k] of declKeys) keys.set(d, k);

  // ── The walk base this run ended in: ranks and components ──
  if (fixed === undefined) assignComponents(states);
  else {
    for (const members of fixed.comps) {
      const rep = [...members].sort()[0]!;
      for (const p of members) {
        const s = states.get(p)!;
        s.o = fixed.ranks.get(p)!;
        if (p !== rep) s.m = rep;
      }
      if (members.length > 1) states.get(rep)!.w = [...members].sort();
    }
  }
  lap("write");

  report.reads = entriesRead;
  report.walk.d = files.size;
  report.walk.rounds = rounds;
  report.walk.entries = entriesRead;
  report.walk.shards = base?.shardsRead ?? 0;
  const r0 = (x: number): number => Math.round(x);
  report.walk.split =
    `phase 0 ${r0(phaseMs.phase0)}ms, phase 1 ${r0(phaseMs.phase1)}ms, final ${r0(phaseMs.final)}ms` +
    (fixed === undefined
      ? ""
      : `; fixed: rec ${r0(fixed.ms.rec)}ms, order ${r0(fixed.ms.order)}ms, stale ${r0(fixed.ms.stale)}ms, grow ${r0(fixed.ms.grow)}ms, ${phaseMs.grows} rank grows`);
  report.walk.shardsBy[3] = report.walk.shards;
  return {
    results,
    keys,
    programDiagnostics,
    checked: [...checked].sort(),
    report,
    walk: {
      base,
      global: baseGlobal,
      globals,
      listings: a.listings,
      files: states,
      removed: inc?.plan.removed ?? [],
      meaning,
      all() {
        const out = new Map<string, FileFinal>();
        const put = (p: string, s: WalkFileState): void =>
          void out.set(p, {
            r: s.r,
            contract: s.c,
            signature: s.s,
            diagnostics: s.e ?? [],
          });
        if (base !== undefined) {
          for (const [p, s] of base.allFiles()) {
            if (sourceSet.has(p) && !states.has(p)) put(p, s);
          }
        }
        for (const [p, s] of states) put(p, s);
        return out;
      },
    },
  };
}

/** A walked file's state for the next walk base. Rank and component come after. */
function stateOf(
  p: string,
  s: {
    version: string;
    global: boolean;
    r: string;
    contract: string;
    result: NameResult;
    names: Readonly<Record<string, Pick<NameRec, "t" | "d">>>;
    star: readonly string[];
    uses: readonly string[];
    reads: readonly string[];
    res: { dirs: readonly string[]; files: readonly string[] };
    meaning(key: string): string;
  },
): WalkFileState {
  const uses = new Set(s.uses.filter((k) => splitKey(k)[0] !== p));
  const out: WalkFileState = {
    v: s.version,
    r: s.r,
    c: s.contract,
    s: s.result.signature,
    n: Object.fromEntries(
      Object.keys(s.names)
        .sort()
        .map((n) => [
          n,
          [s.meaning(nameKey(p, n)), s.names[n]!.t, [...s.names[n]!.d]],
        ]),
    ),
    u: [...uses].sort(),
    o: 0,
  };
  if (s.global) out.g = 1;
  if (s.result.diagnostics.length > 0) out.e = [...s.result.diagnostics];
  if (s.star.length > 0) out.x = [...s.star];
  const extra = s.reads.filter((k) => !uses.has(k));
  if (extra.length > 0) out.k = extra;
  if (s.res.dirs.length > 0) out.pd = [...s.res.dirs];
  if (s.res.files.length > 0) out.pf = [...s.res.files];
  return out;
}
