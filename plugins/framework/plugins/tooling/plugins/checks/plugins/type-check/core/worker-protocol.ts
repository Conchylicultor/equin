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
 * typed parts reused stored keys, which the check reads back by its result
 * key (`TypeCheckWorkerResult.lintKeys`).
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
 *   host-wide store. The walk visits only what changed since the walk base
 *   (`walkBase`). The verdict.
 * - `walks` — the same, beside a FULL WALK of every file over the same store
 *   (its writes kept apart), compared file by file: result key, `.d.ts`,
 *   signature, diagnostics. What validates the incremental walk.
 * - `dual` — `walks`, then a FULL check of a fresh whole program
 *   (`../shared/full-check.ts`), compared file by file. The verdict is the
 *   full check's, every divergence is reported, and on any divergence a cold
 *   run overwrites the store. What the backstop on main runs.
 */
export type TscMode = "keyed" | "walks" | "dual";

/**
 * One file whose result differed: the two-program check's from the full
 * check's (`diagnostics`, `signature`, `missing`), or the incremental walk's
 * from the full walk's (`walk-key`, `walk-contract`, `walk-signature`,
 * `walk-diagnostics`, `walk-missing`).
 */
export interface TscDivergence {
  file: string;
  kind:
    | "diagnostics"
    | "signature"
    | "missing"
    | "walk-key"
    | "walk-contract"
    | "walk-signature"
    | "walk-diagnostics"
    | "walk-missing";
  keyed: string;
  full: string;
}

/**
 * The walk base the worker walks from (`../shared/walk-base.ts`):
 *
 * - `root` — this one, by its root's content hash: the walk state the run
 *   that wrote the lint base (`lintBase`) ended in. Bound to it, so every file
 *   the walk does not visit keeps the result key the lint base holds.
 * - `hint` — the tree this checkout's last completed walk ended on, if it is
 *   stored (a run with no lint base: the build's type check, the backstop).
 * - `none` — walk every file.
 */
export type WalkBaseRef =
  { kind: "root"; root: string } | { kind: "hint" } | { kind: "none" };

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
  /**
   * The files to lint — their stale syntactic parts, and every typed part to
   * decide. With a `lintBase`, only the files whose base state does not carry
   * (changed, added, or under a rule that moved).
   */
  lintFiles: LintFileJob[];
  typedParts: TypedParts;
  /**
   * The RUN BASE the lint was planned against (`../shared/run-base.ts`), by
   * its root's content hash — or null when `lintFiles` names every lintable
   * file (no base, or one under other rules). Every lintable file NOT in
   * `lintFiles` carries its base state: same version, same rules, so its
   * syntactic results stand, and its typed parts stand iff its result key is
   * the base's. The worker reads the base for each such file's key and unit;
   * one whose key moved has every typed part decided like a job's, with
   * `known` its stored typed keys (the per-file lint store, read by the
   * worker), and is answered like one.
   */
  lintBase: string | null;
  /**
   * The walk base the type check's walk starts from. With a `lintBase`, only
   * `root` (the one bound to it) or `none`: the files the walk does not visit
   * must be the ones whose key the lint base holds.
   */
  walkBase: WalkBaseRef;
  /**
   * The input the worker checks: the git tree its every file is versioned by
   * (the blob sha), and the overlay — the gitignored program roots, each with
   * the blob sha of its bytes. Read once by whoever spawns the worker (the
   * check's preparation, which keys lint on the same versions), so the two
   * sides cannot see different trees.
   */
  tree: TypeCheckTree;
}

/**
 * The type check's input, as data: a git tree and its overlay
 * (`../shared/repo-view.ts`). Small — the overlay is the dozen gitignored
 * `*.composition.*.generated.ts` registries the tsconfig includes — so it
 * crosses threads and processes as a value, and each side loads the tree
 * itself from its hash.
 */
export interface TypeCheckTree {
  /** The git tree object hash (the working tree as `computeTreeHash` writes it). */
  treeHash: string;
  /** Each gitignored program root → the git blob sha of its bytes. */
  overlay: Record<string, string>;
}

/** The worker's JSON stdout contract (see `../shared/worker.ts`). */
export interface TypeCheckWorkerResult {
  name: string;
  tscErrors: string;
  /**
   * Raw results, per file where something happened — a job's, or a base
   * file's whose result key moved: the check applies exemptions.
   */
  lint: LintFileResult[];
  /**
   * The result key of every file in `lintFiles`, and of every base file whose
   * key is not the base's — what the check keys typed results by and records
   * in the next base. Null when the worker keyed nothing (an unreadable
   * tsconfig): there is no lint state to record.
   */
  lintKeys: Record<string, string> | null;
  /**
   * Transcript lines from the type check: what each program held and
   * checked, what the walk cost, and in dual mode what the full check found.
   */
  tscLines: string[];
  /**
   * `walks` / `dual` mode only: every file whose incremental result differed
   * from the full walk's, and (dual) whose keyed result differed from the full
   * check's.
   */
  divergences: TscDivergence[];
  /**
   * The walk base this run ended in, by its root's hash — what the next run's
   * lint base binds (`walkBase: root`). Null when none was written.
   */
  walkRoot: string | null;
  /** The files the type check checked (program 1 ∪ program 2), sorted. */
  checked: string[];
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
