import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  acquireDirWatch,
  type DirWatchRelease,
} from "@plugins/infra/plugins/file-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { hostFsVersion, type FileVersion } from "../../core";
import { locateHostPath } from "../../server/internal/archive/locate";
import { classifyFsError, resolveHostPath } from "../../server/internal/path";

/**
 * The disk entry whose bytes answer for `path`: the path itself, or — for a
 * member of an archive — the archive file holding it.
 */
async function anchorOf(path: string): Promise<string> {
  const located = await locateHostPath(path);
  return located.kind === "archive" ? located.file : path;
}

/** The revision of the absolute host path `path` (see `FileVersionSchema`). */
export async function hostPathVersion(path: string): Promise<FileVersion> {
  try {
    const st = await stat(await anchorOf(path));
    return { stamp: `${st.ino}:${st.size}:${st.mtimeMs}` };
  } catch (err) {
    // Missing or unreadable: nothing to stamp. The reader's own read says which.
    classifyFsError(err);
    return { stamp: null };
  }
}

/** A watch of one host path, or why its folder could not be watched. */
export type HostPathWatch =
  | { kind: "watching"; release: DirWatchRelease }
  | { kind: "no-folder"; reason: "missing" | "denied" };

/**
 * Call `onChange` whenever the absolute host path `path` may have changed —
 * its entry (or its archive's) written, replaced, removed or created — until
 * the returned release runs. A children-scope watch of the folder holding it,
 * through the shared dir hub, so it rides any watch already open above it (a
 * checkout's). `no-folder` when that folder does not exist (or cannot be
 * read): nothing can land there until it does, and a remount re-asks. A symlink is watched where it sits,
 * not where it points.
 */
export async function watchHostPath(
  path: string,
  onChange: () => void,
): Promise<HostPathWatch> {
  const anchor = await anchorOf(path);
  let dir: string;
  try {
    // The hub takes the folder as the filesystem reports it (no symlinked
    // prefix: `/tmp` is `/private/tmp`), and its events name paths so.
    dir = await realpath(dirname(anchor));
  } catch (err) {
    return { kind: "no-folder", reason: classifyFsError(err) };
  }
  const entry = join(dir, basename(anchor));
  const release = await acquireDirWatch({
    dir,
    scope: "children",
    onChange: (events) => {
      // The folder itself moving carries the entry with it.
      if (events.some((e) => e.path === entry || e.path === dir)) onChange();
    },
  });
  // A write between the first load and the watch opening produced no event;
  // one re-read closes that gap.
  onChange();
  return { kind: "watching", release };
}

/** Whether `resolveHostPath` refused the spelling (a 400), not the disk. */
function isInvalidPath(err: unknown): err is HttpError {
  return err instanceof HttpError && err.status === 400;
}

/**
 * `notified` by a watch of the file's folder for as long as the tuple has a
 * subscriber. The start is awaited on the subscribe path: the version is read
 * beside the file's own content read, never ahead of it, so holding its
 * sub-ack until the watch is live delays nothing on screen.
 */
export const hostFsVersionServed = serveValue(hostFsVersion, {
  source: "external",
  changes: "notified",
  loader: ({ path }) => {
    let abs: string;
    try {
      abs = resolveHostPath(path);
    } catch (err) {
      if (isInvalidPath(err)) {
        throw hostFsVersion.refuse("invalid-path", err.message);
      }
      throw err;
    }
    return hostPathVersion(abs);
  },
  whileSubscribed: async ({ path }, notify) => {
    let abs: string;
    try {
      abs = resolveHostPath(path);
    } catch (err) {
      // The loader refuses it; there is nothing to watch.
      if (isInvalidPath(err)) return () => {};
      throw err;
    }
    const watch = await watchHostPath(abs, () => notify());
    return watch.kind === "watching" ? watch.release : () => {};
  },
});
