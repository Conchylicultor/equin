import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import {
  pruneWorktreeTestArtifacts,
  worktreeArtifacts,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";

export type TestRunnerName = "bun:test" | "vitest";

export interface TestRunnerOutcome {
  runner: TestRunnerName;
  exitCode: number;
  /** How many test files this runner was given. */
  files: number;
  /**
   * Every failure this runner is known to have had, each a stable identity:
   * `<file> > <suite> > <case>` for a failing case, and `(<runner> exited
   * <code>)` when the runner failed and no failing case explains it — so a
   * failed runner always contributes at least one entry.
   */
  failures: string[];
  /**
   * Files this runner was given that its report never mentions. JUnit cannot
   * say why: the file threw while loading, OR it recorded no test cases at all
   * (an ESLint `RuleTester` file asserts at load time and registers none). Not
   * failures, then — but a file moving INTO this list between two runs is how a
   * new load crash shows up, so a comparison should diff it too.
   */
  unreported: string[];
}

/**
 * One `./singularity test` run's record, at `worktreeArtifacts.testStatus(slug,
 * opId)`. Written when the run starts and again when it ends; see that path's
 * doc for why it is keyed by the run's `opId`.
 */
export interface TestStatus {
  opId: string;
  pid: number;
  startedAt: string;
  targets: string[];
  status: "running" | "passed" | "failed";
  finishedAt: string | null;
  runners: TestRunnerOutcome[];
  /**
   * Set when this run did not run the tests itself but JOINED an identical
   * run already in flight (same test files, same tree) and adopted its verdict:
   * the leader's `opId`. `runners` is then the leader's, copied.
   */
  adoptedFrom?: string;
}

/**
 * Write `status` to its run's record (atomically: temp + rename). A write that
 * CREATES a record (the run's first) also trims the family to the newest
 * `TEST_ARTIFACTS_RETENTION` — writing a new set is what prunes old ones.
 */
export function writeTestStatus(name: Namespace, status: TestStatus): void {
  mkdirSync(worktreeDataDir(name), { recursive: true });
  const path = worktreeArtifacts.testStatus(name, status.opId);
  const fresh = !existsSync(path);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(status, null, 2) + "\n");
  renameSync(tmp, path);
  if (fresh) pruneWorktreeTestArtifacts(name);
}

/** One run's record by its `opId`; `null` when that run wrote none (it never started, or was pruned). */
export function readTestStatus(
  name: Namespace,
  opId: string,
): TestStatus | null {
  const path = worktreeArtifacts.testStatus(name, opId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw) as TestStatus;
}

/**
 * The record of the newest run (by `startedAt`) in this checkout, or `null`
 * when it has none. For a caller that spawned `./singularity test` and so never
 * learned the run's `opId` (the deps upgrade gates); anything holding an
 * `opId` reads that run with `readTestStatus`.
 */
export function readLatestTestStatus(name: Namespace): TestStatus | null {
  const dir = worktreeDataDir(name);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let latest: TestStatus | null = null;
  for (const entry of entries) {
    const m = /^test-status-(.+)\.json$/.exec(entry);
    if (!m?.[1]) continue;
    const status = readTestStatus(name, m[1]);
    if (status && (latest === null || status.startedAt > latest.startedAt))
      latest = status;
  }
  return latest;
}

/**
 * The failure summary of one run's record, as indented lines: what `await`
 * prints under a finished test op, and what a run that joined an in-flight
 * identical run prints for the verdict it adopted — one renderer, so the two
 * cannot disagree. Empty when nothing failed and nothing was adopted.
 */
export function testFailureLines(status: TestStatus): string[] {
  const lines: string[] = [];
  if (status.adoptedFrom !== undefined)
    lines.push(`  adopted the verdict of in-flight run ${status.adoptedFrom}`);
  const failures = status.runners.flatMap((r) => r.failures);
  if (failures.length > 0) {
    lines.push(`  ${failures.length} failing:`);
    lines.push(...failures.slice(0, 10).map((f) => `    ${f}`));
  }
  return lines;
}
