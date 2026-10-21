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
// The store (`./name-store.ts`) is per file text, host-wide: a run writes only
// what it checked.

import { createHash } from "crypto";
import ts from "typescript";
// Through the barrel: the worker imports it the same way.
import type { TscPredictionMiss } from "../core";
import {
  declaresGlobals,
  fileImports,
  runProgram,
  usesOf,
  type CheckedFile,
  type ProgramRun,
  type ProgramStats,
} from "./name-check";
import { contractHash, type SourceFileCache } from "./name-host";
import type { NameRec } from "./name-records";
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
  type WalkFile,
  type WalkInput,
  type WalkVariant,
} from "./name-walk";
import { isRepoPath, needsContract } from "./keys";

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

export interface NameRunInput {
  root: string;
  options: ts.CompilerOptions;
  /** The tsconfig's include expansion, repo-relative. */
  roots: readonly string[];
  /** The engine: compiler, options, dependencies, this code (`tscEngineFp`). */
  engine: string;
  store: NameStore;
  cache: SourceFileCache;
  /** A repo file's version (the hash of its text), or undefined when it is gone. */
  versionOf(path: string): string | undefined;
  textOf(path: string): string;
  lint?: LintHook;
  /**
   * When a name predicted stable moves (a bug in the affected set): `throw`
   * (tests, dual mode — a miss is a failure there), or `whole` — check every
   * file in one program over a store read as empty, so the verdict and every
   * record are right, and say so in `report.missed`. A failed run records
   * nothing, so throwing in the check path would fail every later run alike.
   */
  onMiss: "throw" | "whole";
}

export interface NameResult {
  diagnostics: string[];
  signature: string;
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
    reads: number;
    listings: number;
    walk: number;
    write: number;
  };
  /** Entries read, and resolutions re-recorded. */
  reads: number;
  /**
   * Predicted-stable names that moved in program 2 (must be none): non-empty,
   * this run fell back to one whole program (`onMiss: "whole"`).
   */
  missed: PredictionMiss[];
}

export interface NameRunOutput {
  /** Every repo source file's result, checked or stored. */
  results: Map<string, NameResult>;
  /** Every repo source file's result key (what keys its typed lint). */
  keys: Map<string, string>;
  /** Options and global diagnostics of the environment. */
  programDiagnostics: string[];
  /** The files checked this run (program 1 ∪ program 2), sorted. */
  checked: string[];
  report: NameRunReport;
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

const toTuple = (n: NameRec): [string, string[]] => [n.t, n.d];

export async function runNameCheck(
  input: NameRunInput,
): Promise<NameRunOutput> {
  const { root, options, store, cache } = input;
  const ms = { versions: 0, reads: 0, listings: 0, walk: 0, write: 0 };
  let t = performance.now();
  const lap = (k: keyof typeof ms): void => {
    const now = performance.now();
    ms[k] += now - t;
    t = now;
  };

  const sources = input.roots.filter(needsContract).sort();
  const declRoots = input.roots
    .filter((p) => isRepoPath(p) && !needsContract(p))
    .sort();
  const version = (p: string): string => {
    const v = input.versionOf(p);
    if (v === undefined) throw new Error(`type-check: ${p} has no version`);
    return v;
  };
  const versions = new Map(sources.map((p) => [p, version(p)]));
  lap("versions");

  // ── The stored entries, one per file text ──
  const entries = new Map<string, FileEntry | undefined>();
  for (const p of sources) entries.set(p, store.readEntry(p, versions.get(p)!));
  lap("reads");

  // ── The global hash: the engine, every global file, every repo `.d.ts` ──
  const globals: string[] = [];
  for (const p of sources) {
    const e = entries.get(p);
    const g = e !== undefined ? e.global : declaresGlobals(input.textOf(p), p);
    if (g) globals.push(p);
  }
  const global = sha(
    [
      `engine\0${input.engine}`,
      ...globals.map((p) => `global\0${p}\0${versions.get(p)}`),
      ...declRoots.map((p) => `decl\0${p}\0${version(p)}`),
    ].join("\n"),
  );

  // ── Resolutions: keyed on what they probed ──
  const fs = new ProbeFs(root);
  const resolver = new RecordingResolver(fs, options);
  let moved = 0;
  let refreshed = 0;
  const rewrite = new Set<string>();
  for (const p of sources) {
    const e = entries.get(p);
    if (e === undefined || resolutionHolds(fs, e.res)) continue;
    const res = resolver.record(
      p,
      e.res.targets.map(([s, m]) => [s, m] as [string, number]),
    );
    if (JSON.stringify(res.targets) !== JSON.stringify(e.res.targets)) {
      entries.set(p, undefined); // its imports land elsewhere: check it
      moved++;
    } else {
      e.res = res;
      rewrite.add(p);
      refreshed++;
    }
  }
  lap("listings");

  // ── Phase 0 ──
  const files = new Map<string, WalkFile>();
  for (const p of sources) {
    const e = entries.get(p);
    files.set(p, {
      version: versions.get(p)!,
      uses: e === undefined ? undefined : usesOf(e.imports, e.res.targets),
      variants:
        e === undefined
          ? []
          : e.variants.filter((v) => v.global === global).map(toWalkVariant),
    });
  }
  const walkInput: WalkInput = {
    files,
    global,
    declMeaning: (p) => input.versionOf(p) ?? "-",
    detail: (_p, v) => store.readDetail(v.r),
  };
  const p0 = phase0(walkInput);
  lap("walk");

  const contractText = (hash: string): string => store.readContract(hash);
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
    reads: sources.length,
    missed: [],
  };

  // ── Program 1 ──
  let served = new Map<string, string>();
  let p1Run: ProgramRun | undefined;
  if (p0.first.size > 0) {
    p1Run = runProgram({
      root,
      options,
      sources: p0.first,
      check: p0.first,
      declRoots,
      globals,
      contractOf: (p) => {
        const f = files.get(p);
        if (f === undefined) {
          throw new Error(
            `type-check: ${p} is imported but is not a root of the program (outside the tsconfig include?)`,
          );
        }
        const v = p0.valid.get(p) ?? f.variants[0];
        if (v === undefined) {
          throw new Error(
            `type-check: program 1 needs ${p}'s .d.ts, and none is stored`,
          );
        }
        return contractText(v.contract);
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

  // ── Phase 1: the affected set ──
  const p1 = phase1(walkInput, p0.first, served);
  lap("walk");
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
  const lintOnly = new Set<string>();
  if (input.lint) {
    for (const [p, v] of p1.valid) {
      if (!p1.second.has(p) && input.lint.wants(p, v.r)) lintOnly.add(p);
    }
  }
  report.lintOnly = lintOnly.size;
  let p2Run: ProgramRun | undefined;
  const second = new Map<string, CheckedFile>();
  if (p1.second.size > 0 || lintOnly.size > 0) {
    p1Run = undefined; // program 1 is done: free it before program 2
    p2Run = runProgram({
      root,
      options,
      sources: new Set([...p1.second, ...lintOnly]),
      check: p1.second,
      declRoots,
      globals,
      contractOf: (p) => {
        const f = fresh.get(p);
        if (f !== undefined && p1.confirmed.has(p)) return f.contract;
        const v = p1.valid.get(p);
        if (v === undefined) {
          throw new Error(
            `type-check: program 2 needs ${p}'s .d.ts, which has no valid record`,
          );
        }
        return contractText(v.contract);
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

  /** A file's `.d.ts` at the end of the run: checked this run, or valid. */
  const finalContract = (p: string): string => {
    const c = second.get(p) ?? (p1.confirmed.has(p) ? fresh.get(p) : undefined);
    if (c !== undefined) return c.contract;
    const v = p1.valid.get(p);
    if (v === undefined) {
      throw new Error(
        `type-check: ${p}'s .d.ts is needed and it has no record`,
      );
    }
    return contractText(v.contract);
  };

  // ── The final keys, and the self-check ──
  const checked = new Set<string>([...p1.confirmed.keys(), ...p1.second]);
  const valid = new Map<string, WalkVariant>();
  for (const [p, v] of p1.valid) if (!checked.has(p)) valid.set(p, v);
  const fin = finalKeys(walkInput, valid, checked);
  lap("walk");
  const missed: PredictionMiss[] = [];
  for (const [p, { prev, names }] of p1.stable) {
    const now = second.get(p)!.names;
    for (const n of names) {
      const a = prev.names[n]!;
      const b = now[n];
      if (b === undefined || a.t !== b.t || a.d.join("\n") !== b.d.join("\n")) {
        missed.push({ file: p, name: n });
      }
    }
  }
  if (missed.length > 0) {
    if (input.onMiss === "throw") throw new PredictionMissed(missed);
    // Nothing of this run is recorded. A cold run cannot miss: it has no
    // program 2.
    p1Run = undefined;
    p2Run = undefined;
    input.lint?.discard();
    const whole = await runNameCheck({
      ...input,
      store: coldWriteThrough(store),
      onMiss: "throw",
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
    for (const p of lintOnly) lintable.push({ path: p, r: valid.get(p)!.r });
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
      input.textOf(d),
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
          root,
          options,
          sources: new Set(),
          check: new Set(),
          declRoots,
          globals,
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

  // ── Record ──
  const results = new Map<string, NameResult>();
  const keys = new Map<string, string>();
  const now = Date.now();
  for (const p of sources) {
    const c = second.get(p) ?? (p1.confirmed.has(p) ? fresh.get(p) : undefined);
    if (c !== undefined) {
      const r = fin.keys.get(p)!;
      keys.set(p, r);
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
      const old = entries.get(p);
      store.writeEntry(p, versions.get(p)!, {
        global: c.global,
        imports: c.imports,
        res: c.res,
        variants: [
          variant,
          ...(old?.variants ?? []).filter((v) => v.r !== r),
        ].slice(0, MAX_VARIANTS),
      });
      continue;
    }
    const v = valid.get(p);
    if (v === undefined) {
      throw new Error(`type-check: ${p} was neither checked nor valid`);
    }
    keys.set(p, v.r);
    const e = entries.get(p)!;
    const stored = e.variants.find((x) => x.r === v.r)!;
    results.set(p, {
      diagnostics: stored.diagnostics,
      signature: stored.signature,
    });
    // An entry in use is re-written when old, so the age bound means "unused".
    if (rewrite.has(p) || now - (e.recordedAt ?? 0) > REFRESH_AFTER_MS) {
      store.writeEntry(p, versions.get(p)!, e);
    }
  }

  // ── Program-level diagnostics: from a program built now, or stored ──
  if (programDiagnostics !== undefined) {
    store.writeProgramDiagnostics(global, programDiagnostics);
  } else {
    programDiagnostics = store.readProgramDiagnostics(global);
    if (programDiagnostics === undefined) {
      const empty = runProgram({
        root,
        options,
        sources: new Set(),
        check: new Set(),
        declRoots,
        globals,
        contractOf: finalContract,
        cache,
        resolver,
      });
      programDiagnostics = empty.programDiagnostics;
      store.writeProgramDiagnostics(global, programDiagnostics);
    }
    t = performance.now();
  }
  lap("write");
  for (const [d, k] of declKeys) keys.set(d, k);
  return {
    results,
    keys,
    programDiagnostics,
    checked: [...checked].sort(),
    report,
  };
}
