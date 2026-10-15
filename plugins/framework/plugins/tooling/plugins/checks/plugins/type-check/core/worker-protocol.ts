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

/** One file to lint, and the rule groups to run on it. */
export interface LintFileJob {
  /** Absolute path. */
  file: string;
  /** `LINT_GROUP_ALL`, or the groups whose stored result is stale. */
  groups: typeof LINT_GROUP_ALL | string[];
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

/** One linted file's messages, split by the groups its job named. */
export interface LintFileResult {
  /** Absolute path, as the job named it. */
  file: string;
  /** Every group the job named, each with its messages (possibly none). */
  groups: Record<string, RawLintMessage[]>;
}

/** The job file handed to the worker as `argv[2]` (see `../shared/worker.ts`). */
export interface TypeCheckWorkerJob {
  root: string;
  name: string;
  tsconfigPath: string;
  buildInfoPath: string;
  /** The files to lint under this program — only their stale rule groups. */
  lintFiles: LintFileJob[];
}

/** The worker's JSON stdout contract (see `../shared/worker.ts`). */
export interface TypeCheckWorkerResult {
  name: string;
  tscErrors: string;
  /** Raw results, one per linted file: the check applies exemptions. */
  lint: LintFileResult[];
}
