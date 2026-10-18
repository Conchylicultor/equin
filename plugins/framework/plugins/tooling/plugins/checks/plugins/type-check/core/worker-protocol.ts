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

/** One typed part to key: its rule group, and the rules half of its key. */
export interface TypedPartFp {
  group: string;
  fp: string;
}

/**
 * Which of a file's typed parts must run: its typed rule groups' parts (a
 * split file), or its whole result (a directive file, one part under
 * `LINT_GROUP_ALL`).
 *
 * - `decided` — prepare computed every key from a signature table; `stale` are
 *   the parts with no stored result, each with the key its fresh one goes
 *   under (empty: nothing typed to run).
 * - `deferred` — no signature table for this program, so no key is known until
 *   the worker has the program's type fingerprints: for each part it computes
 *   `typedResultKey(fp, typeFp)` and runs it iff that key is not among `known`
 *   (the file's stored typed keys, a few per part).
 */
export type TypedDecision =
  | { kind: "decided"; stale: { group: string; key: string }[] }
  | { kind: "deferred"; parts: TypedPartFp[]; known: string[] };

/**
 * One file to lint, and which of its parts to run.
 *
 * Two units, because a directive file cannot be split: whether a disable
 * directive is unused depends on every rule, so its whole result is one part
 * (`LINT_GROUP_ALL`), keyed on the types too. Every other file splits into its
 * syntactic groups — each a function of the file's text, run with no program —
 * and one typed part per type-aware group.
 */
export interface LintFileJob {
  /** Absolute path. */
  file: string;
  unit: "split" | "whole";
  /** The syntactic groups whose stored result is stale (none for `whole`). */
  syntactic: string[];
  typed: TypedDecision;
}

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
 * What became of one typed part the job named (a `decided` stale part, or any
 * `deferred` one). `cached`: the worker found the deferred key among `known`,
 * so the stored result under `key` stands. `ran`: fresh messages, to be stored
 * under `key`.
 */
export type TypedPartOutcome =
  | { group: string; kind: "cached"; key: string }
  | { group: string; kind: "ran"; key: string; messages: RawLintMessage[] };

/** One job's results, part by part. */
export interface LintFileResult {
  /** Absolute path, as the job named it. */
  file: string;
  unit: "split" | "whole";
  /** Every syntactic group the job named, each with its messages (possibly none). */
  syntactic: Record<string, RawLintMessage[]>;
  /** One per typed part the job named. */
  typed: TypedPartOutcome[];
}

/**
 * The program's type fingerprints as the worker read them off the buildinfo it
 * wrote, by repo-relative path — or why it could not.
 */
export type TypeFpTable =
  | {
      kind: "table";
      fps: Record<string, string>;
      /**
       * Where the contract edges came from, for the transcript: how many source
       * files, how many the store answered, how many the program's own emit,
       * how many had to be emitted alone (a store miss), and what it cost.
       */
      contracts: string;
    }
  | { kind: "unavailable"; why: string };

/** The job file handed to the worker as `argv[2]` (see `../shared/worker.ts`). */
export interface TypeCheckWorkerJob {
  root: string;
  name: string;
  tsconfigPath: string;
  buildInfoPath: string;
  /** The files to lint under this program — only their stale parts. */
  lintFiles: LintFileJob[];
  /**
   * Whether to compute the program's type fingerprints (and so every source
   * file's contract edges). The check always does — it records them as the
   * signature table; the build's type-check-only fast path never reads them.
   * Implied by a deferred typed part, which cannot be decided without them.
   */
  typeFps: boolean;
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
  /**
   * CPU seconds the worker spent in each phase: building and checking the
   * program (diagnostics and emit), computing the type fingerprints (contract
   * edges included), and linting. What tells a run whose cost is tsc's
   * re-check from one whose cost is lint.
   */
  phaseCpuSeconds: { tsc: number; typeFps: number; lint: number };
}
