// Which lint parts the worker runs, file by file, and what it answers — apart
// from HOW it lints (`./worker.ts`), so a test can drive the same decisions
// with a stand-in linter.
//
// Two kinds of file reach a decision:
//
//   - a JOB (`TypeCheckWorkerJob.lintFiles`): its stale syntactic groups, and
//     its typed parts with the keys stored for them (`known`) — each typed
//     part runs iff `typedResultKey(fp, R)` is not among them;
//   - a BASE file (`TypeCheckWorkerJob.lintBase`), not in the job: its state
//     carries, so nothing runs while its result key R is the base's. When R
//     moved, every typed part of it is stale under the base's key, and it is
//     decided like a job with `known` its stored typed keys (the per-file lint
//     store) — so a key another run already linted under is reused. Only a
//     file the type check KEYED can have moved: the walk base is the one the
//     lint base's run ended in, so every file the walk did not visit has the
//     base's key (`TypeCheckWorkerJob.walkBase`).
//
// The answer (`answer`) is per file where something happened, plus the result
// key of every job and of every base file whose key moved: what the check
// keys typed results by, and records in the next base.

import type {
  LintFileJob,
  LintFileResult,
  RawLintMessage,
  TypedPartOutcome,
  TypedParts,
} from "../core";
import { typedResultKey } from "./keys";

/** What the decisions need of a base file: its version, key and unit. */
export interface BaseFileKey {
  v: string;
  r: string;
  d?: 1;
}

export interface LintDecisionsInput {
  lintFiles: readonly LintFileJob[];
  typedParts: TypedParts;
  /** The base's files, by repo path — undefined when the job names every file. */
  base: { get(path: string): BaseFileKey | undefined } | undefined;
  /** A base file's stored typed keys (the per-file lint store), newest first. */
  knownTyped(path: string, version: string): readonly string[];
  /** The version of a repo path in the checked tree. */
  version(path: string): string | undefined;
  /** Repo path of a job's absolute path, and back. */
  rel(abs: string): string;
  abs(path: string): string;
}

export interface LintDecisions {
  /** True when nothing can be linted: no job, and no base to compare with. */
  idle: boolean;
  /** The repo paths of the jobs. */
  jobs: readonly string[];
  /** The job a path is decided as under result key `r`, if any. */
  jobOf(path: string, r: string): LintFileJob | undefined;
  /** The typed parts of `path` to run under `r`. */
  stale(path: string, r: string): { group: string; key: string }[];
  /** Whether `path`'s typed lint must run under `r`. */
  wants(path: string, r: string): boolean;
  /**
   * Every answer, once the type check has given each file its final key:
   * `ran` holds the typed parts that ran, by path; `syntactic` runs a job's
   * stale syntactic groups.
   */
  answer(
    keys: ReadonlyMap<string, string>,
    ran: ReadonlyMap<string, readonly TypedPartOutcome[]>,
    syntactic: (job: LintFileJob) => Promise<Record<string, RawLintMessage[]>>,
  ): Promise<{ results: LintFileResult[]; lintKeys: Record<string, string> }>;
}

export function createLintDecisions(input: LintDecisionsInput): LintDecisions {
  const byRel = new Map<string, LintFileJob>(
    input.lintFiles.map((f) => [input.rel(f.file), f]),
  );
  const derived = new Map<string, LintFileJob>();
  const { base } = input;

  const jobOf = (path: string, r: string): LintFileJob | undefined => {
    const f = byRel.get(path);
    if (f !== undefined) return f;
    const b = base?.get(path);
    if (b === undefined || b.r === r) return undefined;
    let d = derived.get(path);
    if (d === undefined) {
      // Carried by the plan only while its version is the base's: a base file
      // whose version moved is a job, so a mismatch here is a plan bug.
      const v = input.version(path);
      if (v !== b.v) {
        throw new Error(
          `type-check worker: ${path} is carried from the run base at version ${b.v}, and the tree has ${v ?? "no such file"}`,
        );
      }
      d = {
        file: input.abs(path),
        unit: b.d === 1 ? "whole" : "split",
        syntactic: [],
        typed: { known: [...input.knownTyped(path, b.v)] },
      };
      derived.set(path, d);
    }
    return d;
  };
  const partsOf = (f: LintFileJob) =>
    f.unit === "whole" ? input.typedParts.whole : input.typedParts.split;
  const staleOf = (f: LintFileJob, r: string) =>
    partsOf(f)
      .map(({ group, fp }) => ({ group, key: typedResultKey(fp, r) }))
      .filter((p) => !f.typed.known.includes(p.key));

  /** A file's typed outcomes under its final key, and whether to answer it. */
  const outcome = (
    path: string,
    f: LintFileJob,
    r: string,
    ran: readonly TypedPartOutcome[],
  ): { typed: TypedPartOutcome[]; answer: boolean } => {
    const ranKeys = new Set(ran.map((p) => p.key));
    const typed: TypedPartOutcome[] = [...ran];
    const parts = partsOf(f);
    const newest = new Set(f.typed.known.slice(0, parts.length));
    let moved = ran.length > 0;
    for (const { group, fp } of parts) {
      const key = typedResultKey(fp, r);
      if (ranKeys.has(key)) continue;
      if (!f.typed.known.includes(key)) {
        throw new Error(
          `type-check worker: ${path}'s typed part ${group} is stale and no program linted it`,
        );
      }
      if (!newest.has(key)) moved = true;
      typed.push({ group, kind: "cached", key });
    }
    return {
      typed,
      answer: moved || (f.unit === "split" && f.syntactic.length > 0),
    };
  };

  return {
    idle: byRel.size === 0 && base === undefined,
    jobs: [...byRel.keys()],
    jobOf,
    stale(path, r) {
      const f = jobOf(path, r);
      return f === undefined ? [] : staleOf(f, r);
    },
    wants(path, r) {
      const f = jobOf(path, r);
      return f !== undefined && staleOf(f, r).length > 0;
    },
    async answer(keys, ran, syntactic) {
      const results: LintFileResult[] = [];
      const lintKeys: Record<string, string> = {};
      const answerOne = async (
        path: string,
        f: LintFileJob,
        r: string,
      ): Promise<void> => {
        lintKeys[path] = r;
        const o = outcome(path, f, r, ran.get(path) ?? []);
        if (!o.answer) return;
        const syn =
          f.unit === "split" && f.syntactic.length > 0
            ? await syntactic(f)
            : {};
        results.push({
          file: f.file,
          unit: f.unit,
          syntactic: syn,
          typed: o.typed,
        });
      };
      for (const [path, f] of byRel) {
        const r = keys.get(path);
        if (r === undefined) {
          throw new Error(
            `type-check worker: ${path} was sent to be linted and the type check gave it no result key`,
          );
        }
        await answerOne(path, f, r);
      }
      if (base !== undefined) {
        // Every keyed file the job did not name: a base file whose key moved
        // is answered. (A key with no base file is no lintable one — a repo
        // `.d.ts`, a generated registry.)
        for (const [path, r] of keys) {
          if (byRel.has(path)) continue;
          const b = base.get(path);
          if (b === undefined || r === b.r) continue;
          await answerOne(path, jobOf(path, r)!, r);
        }
      }
      return { results, lintKeys };
    },
  };
}
