// CHECKING A SET OF FILES, bounded: no program holds more than K of them
// (research/2026-10-23-global-type-check-bounded-batches.md).
//
// Program 1 and program 2 of a run (`./name-run.ts`) both check a set here. A
// set of at most K files is one program, in this process, as before. A larger
// one — a cold run, a global change, a wide rebase, the whole-program answer
// to a missed prediction — is checked in dependency-ordered batches
// (`./batch-plan.ts`): each batch is a program holding its files as source and
// served, for every other file, the `.d.ts` it has now — an earlier batch's
// just-emitted one, or the stored one. That is how program 2 is served program
// 1's results already, so a batch changes which program a file is checked in,
// never what it is checked against or keyed on.
//
// Batches run on a `BatchRunner`: the worker's runs each batch in its own
// child process (`./batch-processes.ts`), one at a time — a process's memory
// is what K bounds, and every program re-pays the environment, so parallel
// batches cost CPU (measured: 3 at once, +54–125 %). The fixtures' runs them in
// this process (`inProcessBatches`). A batch lints its
// files inside its program too (typed parts and stale syntactic groups), before
// their result keys are known: the coordinator decides afterwards which typed
// parts were stale under the key (`LintHook.adopt`).

import ts from "typescript";
import type { RawLintMessage } from "../core";
import { isRepoPath, needsContract } from "./keys";
import {
  fileImports,
  runProgram,
  type AmbientModules,
  type CheckedFile,
  type DeclScope,
  type ProgramStats,
} from "./name-check";
import { contractHash, type SourceFileCache } from "./name-host";
import type { RecordingResolver } from "./name-resolve";
import type { RepoView } from "./repo-view";
import { planBatches } from "./batch-plan";

/**
 * A program needs a file's stored `.d.ts`, and the store no longer holds it
 * (aged out): the run starts again with that file re-checked.
 */
export class ContractMissing extends Error {
  constructor(readonly path: string) {
    super(`type-check: the stored .d.ts of ${path} is gone`);
    this.name = "ContractMissing";
  }
}

/** What to lint of one file in a batch — `./lint-engine.ts`'s `LintSpec`. */
export interface BatchLintSpec {
  unit: "split" | "whole";
  syntactic: string[];
  typed: string[];
}

/** One file's lint messages from its batch, by group, key not decided yet. */
export interface BatchLintOut {
  typed: Record<string, RawLintMessage[]>;
  syntactic: Record<string, RawLintMessage[]>;
}

/** One batch, as data: what a child process is handed. */
export interface BatchJob {
  index: number;
  /** Repo paths held as source. */
  sources: string[];
  /** Of which, checked (the rest are only linted). */
  check: string[];
  /** Every other source file's `.d.ts` this batch may load: path → hash. */
  contracts: Record<string, string>;
  /** The files to lint in the program: repo path → spec. */
  lint: Record<string, BatchLintSpec>;
}

/** What a batch process cost, measured by its parent. */
export interface BatchProcessCost {
  cpuMicros: number | undefined;
  maxRssBytes: number | undefined;
  wallMs: number;
}

export type BatchOutcome =
  | {
      kind: "done";
      checked: Record<string, CheckedFile>;
      served: Record<string, string>;
      programDiagnostics: string[];
      stats: ProgramStats;
      lint: Record<string, BatchLintOut>;
      /** Set by a runner that spawned a process for the batch. */
      cost?: BatchProcessCost;
    }
  | { kind: "contract-missing"; path: string };

/** What every batch of one set shares. */
export interface BatchContext {
  view: RepoView;
  options: ts.CompilerOptions;
  declRoots: readonly string[];
  globals: readonly string[];
  declScopes: ReadonlyMap<string, DeclScope>;
  ambient: AmbientModules;
  cache: SourceFileCache;
  resolver: RecordingResolver;
  /** A stored `.d.ts` by hash; throws `ContractMissing` when it aged out. */
  contractText(path: string, hash: string): string;
  /** Lint files inside a program built here (the in-process runner). */
  lintIn?(
    program: ts.Program,
    specs: Readonly<Record<string, BatchLintSpec>>,
  ): Promise<Record<string, BatchLintOut>>;
}

export interface BatchRunner {
  /** How many batches run at once. */
  readonly width: number;
  /** A `.d.ts` this run produced (not in the store yet), before a batch needs it. */
  publish(hash: string, text: string): void;
  run(job: BatchJob): Promise<BatchOutcome>;
  /** Release what `open` took (a spool directory). */
  close(): void;
}

/** How a large set is checked: the bound, and where batches run. */
export interface Batching {
  /** The most files one program holds (an import cycle larger is one batch). */
  k: number;
  open(ctx: BatchContext): BatchRunner;
}

/** How a set was batched, for the transcript. */
export interface BatchStats {
  batches: number;
  width: number;
  k: number;
  components: number;
  largest: number;
  depth: number;
  /** Batch processes, summed / the largest one / an upper bound on the ones alive at once. */
  cpuSeconds: number;
  maxRssBytes: number;
  concurrentRssBytes: number;
  /** Planning: the import edges and the components, wall ms. */
  planMs: number;
}

export interface SetRun {
  /** The program, when the set was one program in this process. */
  program: ts.Program | undefined;
  checked: Map<string, CheckedFile>;
  served: Map<string, string>;
  programDiagnostics: string[];
  stats: ProgramStats;
  batches: BatchStats | undefined;
  /** Lint run in the batches, by repo path, key not decided yet. */
  lint: Map<string, BatchLintOut>;
}

export interface CheckSetInput {
  ctx: BatchContext;
  /** Every source file of the run (each a possible import). */
  all: readonly string[];
  /** The set held as source, and the part of it to check. */
  sources: ReadonlySet<string>;
  check: ReadonlySet<string>;
  /** A source file's `.d.ts` text now, for one program in this process (throws when it has none). */
  contractOf(path: string): string;
  /**
   * The hash of a file's `.d.ts` now — for a file outside the set, or in it
   * and not checked — or undefined when it has none to serve.
   */
  hashOf(path: string): string | undefined;
  /** `.d.ts` texts this run produced that the store does not hold yet, by hash. */
  fresh: ReadonlyMap<string, string>;
  /** The repo targets of a file's imports (the batch order's edges). */
  importsOf(path: string): Iterable<string>;
  /** What to lint of a file in a batch, if anything. */
  lintSpec?(path: string): BatchLintSpec | undefined;
  /** Absent, or a set no larger than its `k`: one program here. */
  batching?: Batching;
}

const emptyStats = (): ProgramStats => ({
  sources: 0,
  checked: 0,
  contracts: 0,
  repoDecls: 0,
  env: 0,
  programMs: 0,
  checkMs: 0,
  recordMs: 0,
});

export async function checkSet(input: CheckSetInput): Promise<SetRun> {
  const { ctx, sources, check, batching } = input;
  if (batching === undefined || sources.size <= batching.k) {
    const run = runProgram({
      view: ctx.view,
      options: ctx.options,
      sources,
      check,
      declRoots: ctx.declRoots,
      globals: ctx.globals,
      declScopes: ctx.declScopes,
      ambient: ctx.ambient,
      contractOf: input.contractOf,
      cache: ctx.cache,
      resolver: ctx.resolver,
    });
    return {
      program: run.program,
      checked: run.checked,
      served: run.served,
      programDiagnostics: run.programDiagnostics,
      stats: run.stats,
      batches: undefined,
      lint: new Map(),
    };
  }
  return checkInBatches(input, batching);
}

/** The repo source files a repo `.d.ts` root imports: in every program, so first. */
export function declImports(
  view: RepoView,
  options: ts.CompilerOptions,
  resolver: RecordingResolver,
  declRoots: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const d of declRoots) {
    if (!/\.d\.[mc]?ts$/.test(d)) continue;
    const sf = ts.createSourceFile(
      d,
      view.readText(d),
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
    );
    for (const [spec, mode] of fileImports(sf, options)) {
      const t = resolver.target(d, spec, mode);
      if (isRepoPath(t) && needsContract(t)) out.add(t);
    }
  }
  return [...out].sort();
}

async function checkInBatches(
  input: CheckSetInput,
  batching: Batching,
): Promise<SetRun> {
  const { ctx, sources, check } = input;
  const t0 = performance.now();
  const runner = batching.open(ctx);
  try {
    const plan = planBatches({
      files: [...sources],
      deps: (p) => input.importsOf(p),
      environment: declImports(
        ctx.view,
        ctx.options,
        ctx.resolver,
        ctx.declRoots,
      ),
      globals: ctx.globals,
      k: batching.k,
      width: runner.width,
    });
    const planMs = performance.now() - t0;

    // The `.d.ts` of every file outside the set (or in it and not checked):
    // what it is now, asked once.
    const outside = new Map<string, string>();
    for (const p of input.all) {
      if (sources.has(p) && check.has(p)) continue;
      const h = input.hashOf(p);
      if (h !== undefined) outside.set(p, h);
    }
    const doneHash = new Map<string, string>();
    const texts = new Map(input.fresh);
    const published = new Set<string>();

    const checked = new Map<string, CheckedFile>();
    const served = new Map<string, string>();
    const lint = new Map<string, BatchLintOut>();
    const stats = emptyStats();
    let programDiagnostics: string[] | undefined;
    const bs: BatchStats = {
      batches: 0,
      width: runner.width,
      k: batching.k,
      components: plan.components,
      largest: plan.largest,
      depth: plan.depth,
      cpuSeconds: 0,
      maxRssBytes: 0,
      concurrentRssBytes: 0,
      planMs,
    };
    /** Each batch process's lifetime and peak: the concurrent bound, at the end. */
    const spans: { from: number; to: number; rss: number }[] = [];

    const merge = (batch: readonly string[], o: BatchOutcome): void => {
      if (o.kind === "contract-missing") throw new ContractMissing(o.path);
      for (const [p, c] of Object.entries(o.checked)) {
        checked.set(p, c);
        const h = contractHash(c.contract);
        doneHash.set(p, h);
        texts.set(h, c.contract);
      }
      for (const [p, h] of Object.entries(o.served)) {
        // A file of the set reached a later batch as its just-emitted
        // `.d.ts`: what holding it as source shows its importers, so it is
        // not SERVED in the walk's sense (`./name-walk.ts` phase 1: a file
        // served a `.d.ts` that turns out stale) — as in one program.
        if (check.has(p)) continue;
        const prev = served.get(p);
        if (prev !== undefined && prev !== h) {
          throw new Error(
            `type-check: ${p}'s .d.ts was served as ${prev} to one batch and ${h} to another`,
          );
        }
        served.set(p, h);
      }
      for (const [p, l] of Object.entries(o.lint)) lint.set(p, l);
      for (const k of Object.keys(stats) as (keyof ProgramStats)[]) {
        stats[k] += o.stats[k];
      }
      if (programDiagnostics === undefined) {
        programDiagnostics = o.programDiagnostics;
      } else if (
        programDiagnostics.join("\n") !== o.programDiagnostics.join("\n")
      ) {
        throw new Error(
          "type-check: two batches of one set report different program-level diagnostics",
        );
      }
      if (o.cost !== undefined) {
        bs.cpuSeconds += (o.cost.cpuMicros ?? 0) / 1e6;
        bs.maxRssBytes = Math.max(bs.maxRssBytes, o.cost.maxRssBytes ?? 0);
      }
      plan.done(batch);
    };

    const running = new Map<number, Promise<void>>();
    let failure: unknown;
    let nextIndex = 0;
    const dispatch = (batch: string[]): void => {
      const index = nextIndex++;
      const inBatch = new Set(batch);
      const contracts: Record<string, string> = {};
      for (const p of input.all) {
        if (inBatch.has(p)) continue;
        const h = doneHash.get(p) ?? outside.get(p);
        if (h === undefined) continue;
        contracts[p] = h;
        const text = texts.get(h);
        if (text !== undefined && !published.has(h)) {
          runner.publish(h, text);
          published.add(h);
        }
      }
      const lintSpecs: Record<string, BatchLintSpec> = {};
      if (input.lintSpec !== undefined) {
        for (const p of batch) {
          const s = input.lintSpec(p);
          if (s !== undefined) lintSpecs[p] = s;
        }
      }
      const job: BatchJob = {
        index,
        sources: batch,
        check: batch.filter((p) => check.has(p)),
        contracts,
        lint: lintSpecs,
      };
      bs.batches++;
      const from = performance.now();
      const promise = runner
        .run(job)
        .then((o) => {
          if (o.kind === "done" && o.cost?.maxRssBytes !== undefined) {
            spans.push({
              from,
              to: performance.now(),
              rss: o.cost.maxRssBytes,
            });
          }
          merge(batch, o);
        })
        .catch((err: unknown) => {
          failure ??= err;
        })
        .finally(() => {
          running.delete(index);
        });
      running.set(index, promise);
    };

    while (!plan.finished()) {
      while (failure === undefined && running.size < runner.width) {
        const batch = plan.next(running.size);
        if (batch === undefined) break;
        dispatch(batch);
      }
      if (running.size === 0) {
        if (failure !== undefined) break;
        throw new Error(
          "type-check: the batch plan has files left and none ready, with no batch running",
        );
      }
      await Promise.race(running.values());
      if (failure !== undefined) {
        await Promise.allSettled(running.values());
        break;
      }
    }
    if (failure !== undefined) throw failure;
    // An upper bound: each process counted at its own peak for its whole life.
    for (const s of spans) {
      let sum = 0;
      for (const o of spans)
        if (o.from <= s.from && s.from < o.to) sum += o.rss;
      bs.concurrentRssBytes = Math.max(bs.concurrentRssBytes, sum);
    }
    for (const p of check) {
      if (!checked.has(p)) {
        throw new Error(`type-check: ${p} was in no batch`);
      }
    }
    return {
      program: undefined,
      checked,
      served,
      programDiagnostics: programDiagnostics ?? [],
      stats,
      batches: bs,
      lint,
    };
  } finally {
    runner.close();
  }
}

/**
 * Batches in this process, one after another — the fixtures' runner. It bounds
 * no memory: programs built one after another in one process kept 11–15 GB
 * resident on the repo, against 5.8 GB for the same batch in a fresh process.
 */
export function inProcessBatches(k: number): Batching {
  return {
    k,
    open(ctx) {
      const published = new Map<string, string>();
      return {
        width: 1,
        publish: (hash, text) => void published.set(hash, text),
        async run(job) {
          const run = runProgram({
            view: ctx.view,
            options: ctx.options,
            sources: new Set(job.sources),
            check: new Set(job.check),
            declRoots: ctx.declRoots,
            globals: ctx.globals,
            declScopes: ctx.declScopes,
            ambient: ctx.ambient,
            contractOf: (p) => {
              const h = job.contracts[p];
              if (h === undefined) throw missingEdge(p, job);
              return published.get(h) ?? ctx.contractText(p, h);
            },
            cache: ctx.cache,
            resolver: ctx.resolver,
          });
          const lint =
            ctx.lintIn !== undefined && Object.keys(job.lint).length > 0
              ? await ctx.lintIn(run.program, job.lint)
              : {};
          return {
            kind: "done",
            checked: Object.fromEntries(run.checked),
            served: Object.fromEntries(run.served),
            programDiagnostics: run.programDiagnostics,
            stats: run.stats,
            lint,
          };
        },
        close: () => published.clear(),
      };
    },
  };
}

/** A batch loaded a file that is neither done nor served: an edge the plan did not see. */
export function missingEdge(path: string, job: BatchJob): Error {
  return new Error(
    `type-check: batch ${job.index} (${job.sources.slice(0, 3).join(", ")}${job.sources.length > 3 ? ", …" : ""}) needs ${path}'s .d.ts, which is neither checked yet nor stored — an import the batch plan did not see`,
  );
}
