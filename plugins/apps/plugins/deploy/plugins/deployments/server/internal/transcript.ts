import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { fstatSync, readSync } from "node:fs";
import {
  openOwnedFd,
  type OwnedFd,
} from "@plugins/packages/plugins/owned-fd/core";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import { DEPLOY_RUN_KIND_ID } from "./kind-id";

/**
 * How many trailing lines of a leg's transcript the failure message is picked
 * from.
 *
 * The same 200 the pipe-streaming loop kept, so the choice of sentence is made
 * over the same amount of evidence it always was. What changed is *which* lines:
 * the loop kept the last 200 **stderr** lines, and a supervised run has one
 * merged transcript, so this is the last 200 lines of everything. The `deploy: `
 * refusal scan is keyed on line CONTENT and is unaffected; only the "last
 * non-blank line" fallback sees more candidates than it used to.
 */
const KEPT_LINES = 200;

/**
 * How much of the tail is read to find them. 256 KiB is far more than 200 lines
 * of CLI output and a bounded read either way — a full deploy transcript can be
 * megabytes, and reading all of it to quote one line would make the failure path
 * the most expensive thing in the run.
 */
const TAIL_BYTES = 256 * 1024;

/**
 * Was this leg ever actually spawned?
 *
 * The supervised-run primitive creates the transcript file BEFORE it spawns the
 * child (so the tail has something to open from the first pump), and nothing
 * else creates it — a ledger row that merely *names* a leg has no file. So the
 * file's existence is the one crisp signal separating "the command ran and
 * something happened to it" from "the backend went away before starting it",
 * which are two very different sentences to put in front of a user.
 *
 * The honest caveat: the artifact prune keeps the newest 50 run sets per kind,
 * so a leg whose transcript has been reaped by 50 later deploys would read as
 * never-started. It is already a failed run either way, and the cost is one
 * slightly-wrong sentence on it.
 */
export function legStarted(legId: string): boolean {
  return existsSync(
    worktreeArtifacts.runTranscript(
      runtimeNamespace(),
      DEPLOY_RUN_KIND_ID,
      legId,
    ),
  );
}

/**
 * The last lines a leg wrote, for {@link verbFailureMessage} to pick from.
 *
 * Read from the transcript FILE rather than accumulated in memory, and that is
 * the supervised-run contract rather than an implementation choice: the child's
 * output goes to a file descriptor, not to a pipe this process holds, so the
 * file is the only complete copy — and it is complete for a leg started by a
 * previous backend exactly as it is for one started here. The child has exited
 * by the time anyone calls this, so there is nothing to wait for.
 *
 * A missing transcript yields no lines. That is not a swallowed failure: the
 * artifact prune reaps the oldest run sets, and a leg whose transcript is gone
 * genuinely has nothing to quote — the caller then falls back to the status,
 * which is what it does for a leg that printed nothing at all.
 */
export function readTranscriptTail(legId: string): string[] {
  const path = worktreeArtifacts.runTranscript(
    runtimeNamespace(),
    DEPLOY_RUN_KIND_ID,
    legId,
  );
  let fd: OwnedFd;
  try {
    fd = openOwnedFd(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let text: string;
  try {
    const size = fstatSync(fd.fd).size;
    const want = Math.min(TAIL_BYTES, size);
    const buf = Buffer.allocUnsafe(want);
    const read = readSync(fd.fd, buf, 0, want, size - want);
    text = buf.subarray(0, Math.max(read, 0)).toString("utf-8");
    // The first line of a mid-file read is whatever the previous line ended
    // with, so it is dropped rather than quoted as a line of its own.
    if (want < size) text = text.slice(text.indexOf("\n") + 1);
  } finally {
    fd.close();
  }
  const lines = text.split("\n");
  // A transcript ends in a newline unless the child died mid-line, so the last
  // piece is usually empty — and a genuinely unterminated last line is the one
  // most worth keeping, so it is only the empty case that is dropped.
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-KEPT_LINES);
}
