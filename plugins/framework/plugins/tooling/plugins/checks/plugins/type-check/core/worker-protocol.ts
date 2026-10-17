/**
 * The wire contract between a type-check worker process and whoever spawned it.
 *
 * It lives in `core/` rather than beside the worker because there are two
 * spawners — the `type-check` check and the build's `--skip-checks` fast path —
 * and exactly one worker. A contract only one side can name is a contract that
 * drifts.
 */

/**
 * The rule group of the lint config builder's own rules (typescript-eslint,
 * react-hooks, eslint core). Every other group is a lint contribution, named by
 * its plugin path — which never has this shape.
 */
export const LINT_GROUP_BASE = "(base)";

/**
 * Every group at once, as ONE result: what a file carrying an eslint directive
 * is linted and stored as, since whether a disable directive is unused depends
 * on every rule.
 */
export const LINT_GROUP_ALL = "(all)";

/**
 * Every TYPE-AWARE rule at once, as one result: the part of a file's lint that
 * reads the program. Its key folds in the file's type fingerprint
 * (`../shared/type-fingerprint.ts`), so it goes stale when a declaration the
 * file can see changes — where every other group's result is a function of the
 * file's text alone.
 */
export const LINT_GROUP_TYPED = "(types)";

/**
 * Whether a file's typed part (its `LINT_GROUP_TYPED` result, or a directive
 * file's whole `LINT_GROUP_ALL` result) must run.
 *
 * - `fresh` — prepare found the result under its key: nothing to run.
 * - `run` — prepare computed the key from a signature table and found no
 *   result; `key` is where the fresh one goes.
 * - `deferred` — no signature table for this program, so the key is not known
 *   until the worker has the program's type fingerprints: the worker computes
 *   `typedResultKey(fp, typeFp)` and runs the part iff that key is not among
 *   `known` (the file's stored typed keys, a handful).
 */
export type TypedDecision =
  | { kind: "fresh" }
  | { kind: "run"; key: string }
  | { kind: "deferred"; fp: string; known: string[] };

/**
 * One file to lint, and which of its parts to run.
 *
 * Two units, because a directive file cannot be split: whether a disable
 * directive is unused depends on every rule, so its whole result is one part,
 * keyed on the types too. Every other file splits into its syntactic groups —
 * each a function of the file's text, run with no program — and its one typed
 * part.
 */
export type LintFileJob =
  | {
      /** Absolute path. */
      file: string;
      unit: "split";
      /** The syntactic groups whose stored result is stale (possibly none). */
      syntactic: string[];
      typed: TypedDecision;
    }
  | {
      file: string;
      unit: "whole";
      typed: Exclude<TypedDecision, { kind: "fresh" }>;
    };

/** One error-level (or fatal) lint message, before any exemption applies. */
export interface RawLintMessage {
  /** null: the linter itself — a parse failure or an unused-disable report. */
  ruleId: string | null;
  fatal: boolean;
  line: number;
  column: number;
  message: string;
}

/**
 * What became of a job's typed part. `cached`: the worker found the deferred
 * key among `known`, so the stored result under `key` stands. `ran`: fresh
 * messages, to be stored under `key`.
 */
export type TypedOutcome =
  | { kind: "fresh" }
  | { kind: "cached"; key: string }
  | { kind: "ran"; key: string; messages: RawLintMessage[] };

/** One job's results, part by part. */
export type LintFileResult =
  | {
      /** Absolute path, as the job named it. */
      file: string;
      unit: "split";
      /** Every syntactic group the job named, each with its messages (possibly none). */
      syntactic: Record<string, RawLintMessage[]>;
      typed: TypedOutcome;
    }
  | {
      file: string;
      unit: "whole";
      typed: Exclude<TypedOutcome, { kind: "fresh" }>;
    };

/**
 * The program's type fingerprints as the worker read them off the buildinfo it
 * wrote, by repo-relative path — or why it could not.
 */
export type TypeFpTable =
  | { kind: "table"; fps: Record<string, string> }
  | { kind: "unavailable"; why: string };

/** The job file handed to the worker as `argv[2]` (see `../shared/worker.ts`). */
export interface TypeCheckWorkerJob {
  root: string;
  name: string;
  tsconfigPath: string;
  buildInfoPath: string;
  /** The files to lint under this program — only their stale parts. */
  lintFiles: LintFileJob[];
}

/** The worker's JSON stdout contract (see `../shared/worker.ts`). */
export interface TypeCheckWorkerResult {
  name: string;
  tscErrors: string;
  /** Raw results, one per job: the check applies exemptions. */
  lint: LintFileResult[];
  /**
   * Every repo file's type fingerprint in the program just built — what the
   * check records as the signature table, so the next run on this program
   * decides every typed part before spawning anything.
   */
  typeFps: TypeFpTable;
}
