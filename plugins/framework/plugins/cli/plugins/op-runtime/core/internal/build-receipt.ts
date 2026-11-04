import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import {
  worktreeArtifacts,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";

/**
 * What became of a build. `running` is written once the build lock is granted;
 * every graceful terminal path rewrites it. There is no `interrupted` on disk —
 * see `resolveReceipt`.
 */
export type BuildReceiptStatus = "running" | "ok" | "failed" | "superseded";

export interface BuildReceipt {
  status: BuildReceiptStatus;
  buildId: string;
  /** The commit this build answers for (HEAD when it took the lock). */
  commit: string | null;
  pid: number;
  startedAt: string;
  /** Set on every graceful terminal path; `null` while running. */
  finishedAt: string | null;
  exitCode: number | null;
  /**
   * The catchable fatal signal that ended this build, when one arrived —
   * `SIGTERM`, `SIGINT`, … — otherwise absent/`null`.
   *
   * This is what makes "killed from outside" distinguishable from "failed its
   * own checks" on disk. Both write `status: "failed"`, but a killed build
   * carries a signal and `exitCode: 128 + signo`, while a build that failed its
   * checks carries no signal and `exitCode: 1`. Before this field existed the
   * two were byte-identical, which is what made the 2026-08-06 incident
   * (`build-1786028341655-x0pix4`) take hours to attribute.
   *
   * Stamped as soon as the signal arrives, not only at the terminal rewrite, so
   * an escalating kill (SIGTERM then SIGKILL, as `timeout -k` and most
   * supervisors do) still leaves the SIGTERM recorded on the `running` receipt
   * the SIGKILL strands — see `interruptedPredecessorWarning`.
   */
  signal?: string | null;
  url: string;
  logPath: string;
}

/**
 * The receipt as a READER should see it: the `running` arm splits by whether the
 * process that wrote it still exists.
 *
 * `interrupted` is the whole point of this file. A build killed by SIGKILL (a
 * caller timeout, an OOM) runs no exit handler, so the terminal rewrite never
 * happens — the receipt is simply left at `running` by a process that is gone.
 * That is unforgeable in the right direction: a build cannot *fail* to deploy and
 * leave `ok`, because `ok` is only ever written by the build that reached its own
 * success path.
 */
export type ResolvedReceipt =
  | { kind: "none" }
  | { kind: "running"; receipt: BuildReceipt }
  | { kind: "interrupted"; receipt: BuildReceipt }
  | { kind: "ok"; receipt: BuildReceipt }
  | { kind: "failed"; receipt: BuildReceipt }
  | { kind: "superseded"; receipt: BuildReceipt };

/**
 * Atomic so a reader never sees a torn file (tmp + rename).
 */
export function writeBuildReceipt(
  name: Namespace,
  receipt: BuildReceipt,
): void {
  const dir = worktreeDataDir(name);
  mkdirSync(dir, { recursive: true });
  const path = worktreeArtifacts.buildStatus(name);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + "\n");
  renameSync(tmp, path);
}

/** The raw receipt, or `null` when this worktree has never recorded a build. */
export function readBuildReceipt(name: Namespace): BuildReceipt | null {
  const path = worktreeArtifacts.buildStatus(name);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // An unreadable receipt is NOT a legitimate "no build here" answer — absence
  // means something specific in this file's grammar, so degrading to null would
  // report "never built" for a worktree that has. Throw, naming the fix.
  try {
    return JSON.parse(raw) as BuildReceipt;
  } catch (err) {
    throw new Error(
      `The deploy receipt at ${path} is not valid JSON, so this worktree's deploy ` +
        `state cannot be read. Delete the file to reset it; the next build rewrites it.`,
      { cause: err },
    );
  }
}

/** `true` iff a process with this pid exists (any owner). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means it exists but belongs to another user — still alive.
    if (code === "EPERM") return true;
    throw err;
  }
}

export function resolveReceipt(receipt: BuildReceipt | null): ResolvedReceipt {
  if (receipt === null) return { kind: "none" };
  if (receipt.status === "running") {
    return pidAlive(receipt.pid)
      ? { kind: "running", receipt }
      : { kind: "interrupted", receipt };
  }
  return { kind: receipt.status, receipt };
}

/** Convenience: read + resolve in one call. */
export function resolveBuildReceipt(name: Namespace): ResolvedReceipt {
  return resolveReceipt(readBuildReceipt(name));
}

/**
 * The warning an op prints when the PREVIOUS build in this worktree never
 * completed, or `null` when there is nothing to say. Returned rather than
 * printed so the shape is testable and the caller owns the stream.
 */
export function interruptedPredecessorWarning(
  resolved: ResolvedReceipt,
): string | null {
  if (resolved.kind !== "interrupted") return null;
  const { buildId, startedAt, url, signal } = resolved.receipt;
  // A signal on an INTERRUPTED receipt means the death escalated: a catchable
  // signal arrived and was stamped, then the process was hard-killed before it
  // finished its own teardown (the shape `kill` followed by `kill -9`, or
  // `timeout -k`, produces). That stamp is the only attribution such a build can
  // ever carry, so it is said here rather than left on disk unread.
  const cause =
    signal != null
      ? ` It was terminated by ${signal}, then killed before finishing its teardown.`
      : "";
  return (
    `\n⚠  The previous build (${buildId}, started ${startedAt}) never completed — ` +
    `it did NOT deploy.${cause}\n   ${url} is still serving whatever was published before it.\n`
  );
}

/**
 * Print that warning, if there is one. Shared by `build`, `check` and `push`:
 * an interrupted build is silent by construction (SIGKILL prints no verdict and
 * sets no exit code the caller can see), so the NEXT op is where it surfaces —
 * and the next op is very often the one about to verify against a stale deploy.
 */
export function reportInterruptedPredecessor(name: Namespace): void {
  const warning = interruptedPredecessorWarning(resolveBuildReceipt(name));
  if (warning !== null) console.warn(warning);
}
