import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { linkSync, mkdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { openOwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import { flockTry } from "@plugins/packages/plugins/flock/server";
import { liveOpsDir } from "../../data-dirs";
import {
  liveOpLink,
  opFile,
  opsDir,
  TMP_SUFFIX,
  type WorktreeOp,
} from "./worktree-op";

// The WRITER half of the per-op liveness marker (`./worktree-op` holds the
// format and the readers). Apart from them because it runs only in the op's
// own CLI process — `./equin build` / `push` / a direct op, never a backend —
// and its `release()` runs in that process's `process.on("exit")` handler,
// which cannot await: so it is synchronous, and exempt from
// `blocking-fs/no-sync-fs` (this plugin's `exempt/index.ts`). The readers a
// backend calls are async.

/** The held marker of one running op. */
export interface WorktreeOpMarker {
  readonly path: AppPath;
  /**
   * Unlink the marker and drop its lock. Call it AFTER the op's terminal event
   * is in the op log: a reader that sees the marker gone must find the verdict
   * already written, never an op that looks killed. Idempotent.
   */
  release(): void;
}

/**
 * Publish this process's liveness marker for op `opId` and hold its lock until
 * `release()` (or process death — the kernel releases it either way).
 *
 * Written to a temp file, locked, hard-linked into the host-wide `live-ops`
 * index, then renamed into place, so a reader only ever sees — under either
 * name — a complete file that is already locked. Both names are one inode,
 * so one lock answers for both. The fd is opened
 * close-on-exec (Bun/libuv open every fd `O_CLOEXEC`), so a child the op spawns
 * does not inherit it: the lock ends with THIS process, however long a child
 * lingers. (The marker test pins that.)
 *
 * `opId` is required: every writer mints one for the op log before it writes
 * its marker, and a marker without it is a live op nobody can look up the
 * outcome of.
 */
export function markWorktreeOpStart(
  slug: string,
  op: WorktreeOp,
  opId: string,
): WorktreeOpMarker {
  const dir = opsDir(slug);
  mkdirSync(dir, { recursive: true });
  mkdirSync(liveOpsDir.path, { recursive: true });
  const path = opFile(slug, opId);
  const link = liveOpLink(slug, opId);
  const tmp = joinAppPath(
    opsDir(slug),
    `${opId}.json.${process.pid}${TMP_SUFFIX}`,
  );
  const fd = openOwnedFd(tmp, "w");
  let linked = false;
  try {
    if (!flockTry(fd.fd))
      throw new Error(
        `worktree-op: could not lock a marker file this process just created (${tmp})`,
      );
    writeSync(
      fd.fd,
      JSON.stringify({
        v: 2,
        kind: op,
        opId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    );
    // Linked before the rename: once the marker is visible, so is its link.
    // EEXIST (an op id reused) throws — two ops must never share one name.
    linkSync(tmp, link);
    linked = true;
    renameSync(tmp, path);
  } catch (err) {
    fd.close();
    rmSync(tmp, { force: true });
    if (linked) rmSync(link, { force: true });
    throw err;
  }
  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      // Unlink first, then close: a reader that opened the file before the
      // unlink and takes the lock after the close only reaps an already-gone
      // path.
      rmSync(path, { force: true });
      rmSync(link, { force: true });
      fd.close();
    },
  };
}
