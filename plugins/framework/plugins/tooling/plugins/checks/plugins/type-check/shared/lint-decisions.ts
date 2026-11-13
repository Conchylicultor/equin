// Which lint parts the worker runs, file by file, and what it answers — apart
// from HOW it lints (`./worker.ts`), so a test can drive the same decisions
// with a stand-in linter.
//
// Two kinds of file reach a decision:
//
//   - a JOB (`TypeCheckWorkerJob.lintFiles`): a text the base does not hold —
//     its stale syntactic groups, and its typed parts with the keys stored
//     for them (`known`); each typed part runs iff `typedResultKey(fp, R)` is
//     not among them;
//   - a BASE file (`TypeCheckWorkerJob.lintBase`), not in the job: its state
//     is the base's, read here, never shipped. Nothing of it runs while its
//     result key R is the base's and no rule it is linted by moved
//     (`LintBaseRef.moved`). Under moved rules, the moved parts run — its
//     moved syntactic groups, its moved typed parts — and every other part
//     stands under the base's key. When R moved, every typed part of it is
//     stale under the base's key, and it is decided like a job with `known`
//     its stored typed keys (the per-file lint store) — so a key another run
//     already linted under is reused. Only a file the type check KEYED can
//     have moved: the walk base is the one the lint base's run ended in, so
//     every file the walk did not visit has the base's key
//     (`TypeCheckWorkerJob.walkBase`).
//
// So a rule edit ships no per-file state: the job is the files whose text
// moved, the base names the rest, and what moved is one list per part kind.
//
// The answer (`answer`) is per file where something happened, plus the result
// key of every job and of every base file decided: what the check keys typed
// results by, and records in the next base.
//
// What needs neither a program nor a result key is named apart
// (`beforeProgram`): every stale syntactic group, and the verdict of every
// carried directive file whose raw parts are the base's. The worker runs it
// before the type check builds any program, because a program, once built,
// stays alive to the end of the process (JSC's optimized code of
// `createProgram`'s inner functions holds its scope), and the collector paces
// the heap at a multiple of what is live: a syntactic rule edit's ~16.5k
// parses and ~470 verdicts after the program grew the worker to ~1.15 GB of
// footprint, before it to ~0.6 GB, same results
// (research/2026-11-12-global-type-check-worker-memory-split.md).
//
// A directive file's typed parts are raw (`TypedParts`): decided like a split
// file's, in a program. Its verdict (`TypedParts.all`, keyed on R too) is
// decided in `answer`, once R is known, and runs with NO program when its key
// is not known: from the raw parts that ran here and the ones reused under
// their key.

import {
  LINT_GROUP_ALL,
  type LintFileJob,
  type LintFileResult,
  type LintTarget,
  type MovedLintParts,
  type RawLintMessage,
  type TypedPartFp,
  type TypedPartOutcome,
  type TypedParts,
} from "../core";
import { typedResultKey } from "./keys";

/**
 * What the decisions need of a base file: its version, key, unit, and — for
 * a directive file — its non-empty raw typed parts, which its verdict replays.
 */
export interface BaseFileKey {
  v: string;
  r: string;
  d?: 1;
  w?: Record<string, RawLintMessage[]>;
}

/** The run base a job carries from, as the decisions read it. */
export interface LintDecisionsBase {
  get(path: string): BaseFileKey | undefined;
  /**
   * Every path the base holds. Read only when rules moved: then every file
   * the base carries has a moved part to decide.
   */
  paths(): Iterable<string>;
  moved: MovedLintParts;
}

export interface LintDecisionsInput {
  lintFiles: readonly LintFileJob[];
  typedParts: TypedParts;
  /** The run base — undefined when the job names every file. */
  base: LintDecisionsBase | undefined;
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
  /**
   * The repo paths the type check must key and, when their typed lint must
   * run, hold in a program: the jobs, and — when a typed rule moved — every
   * file the base carries with a moved typed part.
   */
  jobs: readonly string[];
  /**
   * What runs with no program and under no result key, to run before the type
   * check builds a program: the stale syntactic groups of every target that
   * has some (a pure function of the text and the groups), and — when the
   * verdicts moved and no raw part did — every carried directive file's
   * verdict from the base's raw parts. A verdict is a function of the text
   * and the raw messages it replays, so the worker uses an early one only
   * when `answer` hands `combined` the same raw messages (the file's key
   * stayed the base's); otherwise it is combined again.
   */
  beforeProgram(): {
    syntactic: LintTarget[];
    verdicts: { target: LintTarget; raw: RawLintMessage[] }[];
  };
  /** What a path is linted as under result key `r`, if anything of it runs. */
  jobOf(path: string, r: string): LintTarget | undefined;
  /**
   * What a path WOULD be linted as if its key moved — a job, or a base
   * file — for linting it in a batch before its key is known.
   */
  speculative(path: string): LintTarget | undefined;
  /** The typed parts' groups of a target's unit. */
  typedGroups(target: LintTarget): string[];
  /** The typed parts of `path` to run under `r`. */
  stale(path: string, r: string): { group: string; key: string }[];
  /** Whether `path`'s typed lint must run under `r`. */
  wants(path: string, r: string): boolean;
  /**
   * Every answer, once the type check has given each file it keyed its final
   * key (a base file it did not key keeps the base's): `ran` holds the typed
   * parts that ran, by path; `syntactic` runs a target's stale syntactic
   * groups; `combined` a directive file's verdict from its raw typed
   * messages, with no program.
   */
  answer(
    keys: ReadonlyMap<string, string>,
    ran: ReadonlyMap<string, readonly TypedPartOutcome[]>,
    syntactic: (
      target: LintTarget,
    ) => Promise<Record<string, RawLintMessage[]>>,
    combined: (
      target: LintTarget,
      raw: readonly RawLintMessage[],
    ) => Promise<RawLintMessage[]>,
  ): Promise<{ results: LintFileResult[]; lintKeys: Record<string, string> }>;
}

/** One typed part of a file: which kind, its group, its rules' fingerprint. */
type Part = TypedPartFp & { kind: "split" | "raw" | "all" };

/**
 * Whether a part's result under a key is known: no; from the store or the
 * job, among the newest keys (`newest`) or not (`older`: reusing it moves it
 * up, so the file is answered); or the base's own (`base`: the base holds it,
 * nothing is answered for it).
 */
type Known = "no" | "newest" | "older" | "base";

/** A file under its result key: what runs of it, and what is known. */
interface Decision {
  target: LintTarget;
  known(part: Part, key: string): Known;
  /** A known raw part's stored messages (a directive file's). */
  messages(part: Part, key: string): readonly RawLintMessage[];
}

export function createLintDecisions(input: LintDecisionsInput): LintDecisions {
  const byRel = new Map<string, LintFileJob>(
    input.lintFiles.map((f) => [input.rel(f.file), f]),
  );
  const { base } = input;
  const moved = base?.moved;
  const movedTyped = new Set(moved?.typed);
  const movedRaw = new Set(moved?.raw);
  const movedSplit =
    moved !== undefined &&
    (moved.syntactic.length > 0 || moved.typed.length > 0);
  const movedWhole = moved !== undefined && (moved.raw.length > 0 || moved.all);

  if (base !== undefined) {
    // The job is the texts the base does not hold: a held text shipped here
    // would be the whole per-file state the base already names.
    for (const path of byRel.keys()) {
      const b = base.get(path);
      if (b !== undefined && b.v === input.version(path)) {
        throw new Error(
          `type-check worker: ${path} is sent to be linted, and the run base holds its text — a carried file is decided from the base, never shipped`,
        );
      }
    }
  }

  const partsOf = (unit: LintTarget["unit"]): Part[] =>
    unit === "whole"
      ? input.typedParts.whole.map((p) => ({ ...p, kind: "raw" as const }))
      : input.typedParts.split.map((p) => ({ ...p, kind: "split" as const }));
  const allPart = (): Part => {
    const { all } = input.typedParts;
    if (all === null) {
      throw new Error(
        "type-check worker: a directive file is linted by a job with no verdict part (NO_TYPED_PARTS)",
      );
    }
    return { ...all, kind: "all" };
  };

  /** A decision from keys known for the text (the job's, or the store's). */
  const fromKeys = (
    target: LintTarget,
    keys: readonly string[],
    messages: Readonly<Record<string, RawLintMessage[]>>,
  ): Decision => {
    const all = new Set(keys);
    const newest = new Set(
      keys.slice(
        0,
        partsOf(target.unit).length + (target.unit === "whole" ? 1 : 0),
      ),
    );
    return {
      target,
      known: (_p, key) =>
        !all.has(key) ? "no" : newest.has(key) ? "newest" : "older",
      messages: (_p, key) => messages[key] ?? [],
    };
  };
  const jobDecisions = new Map<string, Decision>();
  const ofJob = (path: string, f: LintFileJob): Decision => {
    let d = jobDecisions.get(path);
    if (d === undefined) {
      d = fromKeys(
        { file: f.file, unit: f.unit, syntactic: f.syntactic },
        f.typed.known,
        f.unit === "whole" ? f.knownMessages : {},
      );
      jobDecisions.set(path, d);
    }
    return d;
  };

  /** A base file, checked against the tree: carried only at its version. */
  const carried = (path: string, b: BaseFileKey): void => {
    // Carried by the plan only while its version is the base's: a base file
    // whose version moved is a job, so a mismatch here is a plan bug.
    const v = input.version(path);
    if (v !== b.v) {
      throw new Error(
        `type-check worker: ${path} is carried from the run base at version ${b.v}, and the tree has ${v ?? "no such file"}`,
      );
    }
  };
  const targetOf = (path: string, b: BaseFileKey): LintTarget =>
    b.d === 1
      ? { file: input.abs(path), unit: "whole", syntactic: [] }
      : {
          file: input.abs(path),
          unit: "split",
          syntactic: moved?.syntactic ?? [],
        };
  /** Base files whose key moved: decided from the store, read once. */
  const storeDecisions = new Map<string, Decision>();
  const ofBase = (path: string, b: BaseFileKey, r: string): Decision => {
    carried(path, b);
    if (r !== b.r) {
      let d = storeDecisions.get(path);
      if (d === undefined) {
        const known = input.knownTyped(path, b.v);
        d = fromKeys(targetOf(path, b), known.keys, known.messages);
        storeDecisions.set(path, d);
      }
      return d;
    }
    // Its key is the base's: every part whose rules did not move is the
    // base's — no key to compare, no state to read but its raw messages.
    const movedPart = (p: Part): boolean =>
      p.kind === "split"
        ? movedTyped.has(p.group)
        : p.kind === "raw"
          ? movedRaw.has(p.group)
          : moved!.all;
    return {
      target: targetOf(path, b),
      known: (p) => (movedPart(p) ? "no" : "base"),
      messages: (p) => b.w?.[p.group] ?? [],
    };
  };
  const decide = (path: string, r: string): Decision | undefined => {
    const f = byRel.get(path);
    if (f !== undefined) return ofJob(path, f);
    const b = base?.get(path);
    if (b === undefined) return undefined;
    if (r === b.r && !(b.d === 1 ? movedWhole : movedSplit)) return undefined;
    return ofBase(path, b, r);
  };
  const staleOf = (d: Decision, r: string) =>
    partsOf(d.target.unit)
      .map((p) => ({ part: p, key: typedResultKey(p.fp, r) }))
      .filter(({ part, key }) => d.known(part, key) === "no")
      .map(({ part, key }) => ({ group: part.group, key }));

  /** Every file the base carries, when a rule moved: each has a moved part. */
  const carriedPaths: string[] = [];
  /**
   * Of those, the ones with a moved part only a program can run (a typed
   * part, a directive file's raw one): the type check must key them and hold
   * them in a program. A moved syntactic group or verdict runs with none.
   */
  const programPaths: string[] = [];
  if (base !== undefined && (movedSplit || movedWhole)) {
    for (const path of base.paths()) {
      if (byRel.has(path) || input.version(path) === undefined) continue;
      const b = base.get(path)!;
      carried(path, b);
      if (!(b.d === 1 ? movedWhole : movedSplit)) continue;
      carriedPaths.push(path);
      if (b.d === 1 ? movedRaw.size > 0 : movedTyped.size > 0) {
        programPaths.push(path);
      }
    }
  }

  /**
   * A file's typed outcomes under its final key, and whether to answer it —
   * for a directive file, its verdict too, combined here when its key is not
   * known.
   */
  const outcome = async (
    path: string,
    d: Decision,
    r: string,
    ran: readonly TypedPartOutcome[],
    combined: (
      target: LintTarget,
      raw: readonly RawLintMessage[],
    ) => Promise<RawLintMessage[]>,
  ): Promise<{ typed: TypedPartOutcome[]; answer: boolean }> => {
    const ranMessages = new Map<string, RawLintMessage[]>();
    for (const p of ran)
      if (p.kind === "ran") ranMessages.set(p.key, p.messages);
    const typed: TypedPartOutcome[] = [...ran];
    const { unit } = d.target;
    let answer = ran.length > 0;
    /** A known part's outcome; false when no part of it is known. */
    const reuse = (part: Part, key: string): boolean => {
      const k = d.known(part, key);
      if (k === "no") return false;
      if (k === "older") answer = true;
      if (k !== "base") typed.push({ group: part.group, kind: "cached", key });
      return true;
    };
    const raw: RawLintMessage[] = [];
    for (const part of partsOf(unit)) {
      const key = typedResultKey(part.fp, r);
      const m = ranMessages.get(key);
      if (m !== undefined) {
        raw.push(...m);
        continue;
      }
      if (!reuse(part, key)) {
        throw new Error(
          `type-check worker: ${path}'s typed part ${part.group} is stale and no program linted it`,
        );
      }
      if (unit === "whole") raw.push(...d.messages(part, key));
    }
    if (unit === "whole") {
      const all = allPart();
      const key = typedResultKey(all.fp, r);
      if (!reuse(all, key)) {
        answer = true;
        typed.push({
          group: LINT_GROUP_ALL,
          kind: "ran",
          key,
          messages: await combined(d.target, raw),
        });
      }
    }
    return {
      typed,
      answer: answer || (unit === "split" && d.target.syntactic.length > 0),
    };
  };

  /** A carried directive file's raw messages under the base's key. */
  const baseRaw = (b: BaseFileKey): RawLintMessage[] =>
    partsOf("whole").flatMap((p) => b.w?.[p.group] ?? []);

  return {
    idle: byRel.size === 0 && base === undefined,
    jobs: [...byRel.keys(), ...programPaths],
    beforeProgram() {
      const syntactic: LintTarget[] = [];
      const verdicts: { target: LintTarget; raw: RawLintMessage[] }[] = [];
      for (const [path, f] of byRel) {
        const { target } = ofJob(path, f);
        if (target.unit === "split" && target.syntactic.length > 0) {
          syntactic.push(target);
        }
      }
      for (const path of carriedPaths) {
        const b = base!.get(path)!;
        const target = targetOf(path, b);
        if (target.unit === "split") {
          if (target.syntactic.length > 0) syntactic.push(target);
        } else if (moved!.all && movedRaw.size === 0) {
          verdicts.push({ target, raw: baseRaw(b) });
        }
      }
      return { syntactic, verdicts };
    },
    jobOf: (path, r) => decide(path, r)?.target,
    speculative(path) {
      const f = byRel.get(path);
      if (f !== undefined) return ofJob(path, f).target;
      const b = base?.get(path);
      if (b === undefined) return undefined;
      carried(path, b);
      return targetOf(path, b);
    },
    typedGroups: (t) => partsOf(t.unit).map((p) => p.group),
    stale(path, r) {
      const d = decide(path, r);
      return d === undefined ? [] : staleOf(d, r);
    },
    wants(path, r) {
      const d = decide(path, r);
      return d !== undefined && staleOf(d, r).length > 0;
    },
    async answer(keys, ran, syntactic, combined) {
      const results: LintFileResult[] = [];
      const lintKeys: Record<string, string> = {};
      const answerOne = async (
        path: string,
        d: Decision,
        r: string,
      ): Promise<void> => {
        lintKeys[path] = r;
        const o = await outcome(path, d, r, ran.get(path) ?? [], combined);
        if (!o.answer) return;
        const { target } = d;
        const syn =
          target.unit === "split" && target.syntactic.length > 0
            ? await syntactic(target)
            : {};
        results.push({
          file: target.file,
          unit: target.unit,
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
        await answerOne(path, ofJob(path, f), r);
      }
      if (base !== undefined) {
        // Every base file whose key moved, and — when rules moved — every
        // one the base carries, under its key (the base's, unless the type
        // check keyed it). A key with no base file is no lintable one — a
        // repo `.d.ts`, a generated registry.
        const decided = new Set<string>();
        const one = async (path: string, r: string): Promise<void> => {
          if (decided.has(path)) return;
          decided.add(path);
          const d = decide(path, r);
          if (d !== undefined) await answerOne(path, d, r);
        };
        for (const path of carriedPaths) {
          await one(path, keys.get(path) ?? base.get(path)!.r);
        }
        for (const [path, r] of keys) {
          if (byRel.has(path) || base.get(path) === undefined) continue;
          await one(path, r);
        }
      }
      return { results, lintKeys };
    },
  };
}
