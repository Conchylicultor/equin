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
 * Which of a file's typed parts must run — the job's `typedParts.split` for a
 * split file, `typedParts.whole` (one part under `LINT_GROUP_ALL`) for a
 * directive file. Decided in the worker, which alone knows each file's result
 * key: for each part it computes `typedResultKey(fp, resultKey)` and runs it
 * iff that key is not among `known` (the file's stored typed keys, newest
 * first, a few per part).
 */
export interface TypedDecision {
  known: string[];
}

/** The typed parts of every split file, and of every directive file. */
export interface TypedParts {
  split: TypedPartFp[];
  whole: TypedPartFp[];
}

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
 * What became of one typed part the job named. `cached`: its key is among
 * `known`, so the stored result under `key` stands. `ran`: fresh messages, to
 * be stored under `key`.
 */
export type TypedPartOutcome =
  | { group: string; kind: "cached"; key: string }
  | { group: string; kind: "ran"; key: string; messages: RawLintMessage[] };

/**
 * One job's results, part by part — returned only for a file where something
 * happened: a part ran, or a typed key it reused is not already among the
 * newest of its stored keys (the record moves it up). Every other file's
 * typed parts reused the newest stored keys, which is what the check reads
 * back without an answer.
 */
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
 * How the worker type-checks (`../shared/name-run.ts`):
 *
 * - `keyed` — the two programs: re-check only the files with no valid stored
 *   result and what their changed names reach; everything else comes from the
 *   host-wide store. The verdict.
 * - `dual` — the same, then a FULL check of a fresh whole program
 *   (`../shared/full-check.ts`), compared file by file. The verdict is the
 *   full check's, every divergence is reported, and on any divergence a cold
 *   run overwrites the store. What the backstop on main runs.
 */
export type TscMode = "keyed" | "dual";

/** One file whose two-program result differed from the full check's (dual only). */
export interface TscDivergence {
  file: string;
  kind: "diagnostics" | "signature" | "missing";
  keyed: string;
  full: string;
}

/**
 * A name program 2 found moved that the affected set predicted stable — a bug
 * in the affected set. A check run answers with one whole program instead and
 * reports it; dual mode fails.
 */
export interface TscPredictionMiss {
  file: string;
  name: string;
}

/** The job file handed to the worker as `argv[2]` (see `../shared/worker.ts`). */
export interface TypeCheckWorkerJob {
  root: string;
  name: string;
  tsconfigPath: string;
  tscMode: TscMode;
  /**
   * When program 2 finds a name moved that the affected set predicted stable:
   * `throw` (the backstop, the validation script — a miss is the failure they
   * look for), or `whole` (a check run: answer from one whole program and
   * return the miss in `missed`; throwing would fail every later run alike,
   * since a failed run records nothing).
   */
  onMiss: "throw" | "whole";
  /** The files to lint — their stale syntactic parts, and every typed part to decide. */
  lintFiles: LintFileJob[];
  typedParts: TypedParts;
  /**
   * Repo files' versions (sha256 of the text) the caller already computed —
   * the check's preparation hashes every lintable file. The worker hashes the
   * rest itself.
   */
  versions: Record<string, string>;
}

/** The worker's JSON stdout contract (see `../shared/worker.ts`). */
export interface TypeCheckWorkerResult {
  name: string;
  tscErrors: string;
  /** Raw results, one per job: the check applies exemptions. */
  lint: LintFileResult[];
  /**
   * Transcript lines from the type check: what each program held and
   * checked, what the walk cost, and in dual mode what the full check found.
   */
  tscLines: string[];
  /** Dual mode only: every file whose keyed result differed from the full check's. */
  divergences: TscDivergence[];
  /**
   * Keyed mode: the names the affected set missed, when it did — the verdict
   * is then one whole program's, and the check files each as a report.
   */
  missed: TscPredictionMiss[];
  /**
   * CPU seconds the worker spent in each phase: the type check (the walk,
   * both programs' build, checking and emitting the files they check), the
   * full check a dual run adds, and linting (typed lint inside the programs,
   * syntactic lint with none). What tells a run whose cost is tsc's re-check
   * from one whose cost is lint.
   */
  phaseCpuSeconds: {
    check: number;
    full: number;
    lint: number;
  };
  /** What the type check did: program sizes, files checked and linted. */
  stats: TypeCheckStats;
}

/** One program of a run: its sources (checked, or there to be linted) and served `.d.ts`. */
export interface ProgramSize {
  sources: number;
  checked: number;
  contracts: number;
}

/** What one worker run did, for the cost line. */
export interface TypeCheckStats {
  /** Repo source files. */
  files: number;
  first: ProgramSize | null;
  second: ProgramSize | null;
  /** Files checked (program 1 ∪ program 2). */
  checked: number;
  /** Files whose typed lint ran, and whose syntactic lint ran. */
  typedLinted: number;
  syntacticLinted: number;
}
