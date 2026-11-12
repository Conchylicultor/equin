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
//
// A directive file's typed parts are raw (`TypedParts`): decided like a split
// file's, in a program. Its verdict (`TypedParts.all`, keyed on R too) is
// decided in `answer`, once R is known, and runs with NO program when its key
// is not known: from the raw parts that ran here and the ones reused under
// their key (`knownMessages`).

import {
  LINT_GROUP_ALL,
  type LintFileJob,
  type LintFileResult,
  type RawLintMessage,
  type TypedPartOutcome,
  type TypedParts,
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
  /**
   * A base file's stored typed keys (the per-file lint store), newest first,
   * and their non-empty messages.
   */
  knownTyped(
    path: string,
    version: string,
  ): { keys: readonly string[]; messages: Record<string, RawLintMessage[]> };
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
  /**
   * The job a path WOULD be decided as if its key moved — a job, or a base
   * file — for linting it in a batch before its key is known.
   */
  speculative(path: string): LintFileJob | undefined;
  /** The typed parts' groups a job runs when all are stale. */
  typedGroups(job: LintFileJob): string[];
  /** The typed parts of `path` to run under `r`. */
  stale(path: string, r: string): { group: string; key: string }[];
  /** Whether `path`'s typed lint must run under `r`. */
  wants(path: string, r: string): boolean;
  /**
   * Every answer, once the type check has given each file its final key:
   * `ran` holds the typed parts that ran, by path; `syntactic` runs a job's
   * stale syntactic groups; `combined` a directive file's verdict from its
   * raw typed messages, with no program.
   */
  answer(
    keys: ReadonlyMap<string, string>,
    ran: ReadonlyMap<string, readonly TypedPartOutcome[]>,
    syntactic: (job: LintFileJob) => Promise<Record<string, RawLintMessage[]>>,
    combined: (
      job: LintFileJob,
      raw: readonly RawLintMessage[],
    ) => Promise<RawLintMessage[]>,
  ): Promise<{ results: LintFileResult[]; lintKeys: Record<string, string> }>;
}

export function createLintDecisions(input: LintDecisionsInput): LintDecisions {
  const byRel = new Map<string, LintFileJob>(
    input.lintFiles.map((f) => [input.rel(f.file), f]),
  );
  const derived = new Map<string, LintFileJob>();
  const { base } = input;

  const derive = (path: string, b: BaseFileKey): LintFileJob => {
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
      const known = input.knownTyped(path, b.v);
      const file = input.abs(path);
      const typed = { known: [...known.keys] };
      d =
        b.d === 1
          ? {
              file,
              unit: "whole",
              syntactic: [],
              typed,
              knownMessages: known.messages,
            }
          : { file, unit: "split", syntactic: [], typed };
      derived.set(path, d);
    }
    return d;
  };
  const jobOf = (path: string, r: string): LintFileJob | undefined => {
    const f = byRel.get(path);
    if (f !== undefined) return f;
    const b = base?.get(path);
    if (b === undefined || b.r === r) return undefined;
    return derive(path, b);
  };
  const partsOf = (f: LintFileJob) =>
    f.unit === "whole" ? input.typedParts.whole : input.typedParts.split;
  const staleOf = (f: LintFileJob, r: string) =>
    partsOf(f)
      .map(({ group, fp }) => ({ group, key: typedResultKey(fp, r) }))
      .filter((p) => !f.typed.known.includes(p.key));

  /**
   * A file's typed outcomes under its final key, and whether to answer it —
   * for a directive file, its verdict too, combined here when its key is not
   * known.
   */
  const outcome = async (
    path: string,
    f: LintFileJob,
    r: string,
    ran: readonly TypedPartOutcome[],
    combined: (
      job: LintFileJob,
      raw: readonly RawLintMessage[],
    ) => Promise<RawLintMessage[]>,
  ): Promise<{ typed: TypedPartOutcome[]; answer: boolean }> => {
    const ranMessages = new Map<string, RawLintMessage[]>();
    for (const p of ran)
      if (p.kind === "ran") ranMessages.set(p.key, p.messages);
    const typed: TypedPartOutcome[] = [...ran];
    const parts = partsOf(f);
    const newest = new Set(
      f.typed.known.slice(0, parts.length + (f.unit === "whole" ? 1 : 0)),
    );
    let moved = ran.length > 0;
    /** The messages of a part under `key`: what ran, else what was stored. */
    const messagesOf = (key: string): readonly RawLintMessage[] => {
      const m = ranMessages.get(key);
      if (m !== undefined) return m;
      if (f.unit !== "whole") {
        throw new Error(
          `type-check worker: ${path} is no directive file, and its stored typed messages were asked for`,
        );
      }
      return f.knownMessages[key] ?? [];
    };
    const rawKeys: string[] = [];
    for (const { group, fp } of parts) {
      const key = typedResultKey(fp, r);
      rawKeys.push(key);
      if (ranMessages.has(key)) continue;
      if (!f.typed.known.includes(key)) {
        throw new Error(
          `type-check worker: ${path}'s typed part ${group} is stale and no program linted it`,
        );
      }
      if (!newest.has(key)) moved = true;
      typed.push({ group, kind: "cached", key });
    }
    if (f.unit === "whole") {
      const { all } = input.typedParts;
      if (all === null) {
        throw new Error(
          `type-check worker: directive file ${path} is linted by a job with no verdict part (NO_TYPED_PARTS)`,
        );
      }
      const key = typedResultKey(all.fp, r);
      if (f.typed.known.includes(key)) {
        if (!newest.has(key)) moved = true;
        typed.push({ group: LINT_GROUP_ALL, kind: "cached", key });
      } else {
        moved = true;
        typed.push({
          group: LINT_GROUP_ALL,
          kind: "ran",
          key,
          messages: await combined(f, rawKeys.flatMap(messagesOf)),
        });
      }
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
    speculative(path) {
      const f = byRel.get(path);
      if (f !== undefined) return f;
      const b = base?.get(path);
      return b === undefined ? undefined : derive(path, b);
    },
    typedGroups: (f) => partsOf(f).map((p) => p.group),
    stale(path, r) {
      const f = jobOf(path, r);
      return f === undefined ? [] : staleOf(f, r);
    },
    wants(path, r) {
      const f = jobOf(path, r);
      return f !== undefined && staleOf(f, r).length > 0;
    },
    async answer(keys, ran, syntactic, combined) {
      const results: LintFileResult[] = [];
      const lintKeys: Record<string, string> = {};
      const answerOne = async (
        path: string,
        f: LintFileJob,
        r: string,
      ): Promise<void> => {
        lintKeys[path] = r;
        const o = await outcome(path, f, r, ran.get(path) ?? [], combined);
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
