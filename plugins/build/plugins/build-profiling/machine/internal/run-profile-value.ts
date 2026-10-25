import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  asNamespace,
  isNamespace,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import {
  acquireDirWatch,
  type DirWatchRelease,
} from "@plugins/infra/plugins/file-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { buildRunProfile } from "../../core";

/** What the CLI's profiler writes (`op-runtime/cli/profiler.ts`). */
interface BuildProfileFile {
  spans: Array<{
    id: string;
    phase: string;
    label: string;
    startMs: number;
    durationMs: number;
    maxRssBytes?: number;
  }>;
  totalDurationMs: number;
}

// The build id is joined into a filename: one segment of filename-safe
// characters, never a path. The worktree is held to the namespace grammar —
// stricter, and the rule the gateway itself applies.
const BUILD_ID = /^[a-zA-Z0-9._-]+$/;

/** The profile file a tuple names, or `null` when its params cannot name one. */
function profilePathOf({
  buildId,
  worktree,
}: {
  buildId: string;
  worktree?: string;
}): string | null {
  if (!BUILD_ID.test(buildId) || buildId.startsWith(".")) return null;
  let ns: Namespace;
  if (worktree === undefined) ns = runtimeNamespace();
  else if (isNamespace(worktree)) ns = asNamespace(worktree);
  else return null;
  return worktreeArtifacts.buildProfile(ns, buildId);
}

/**
 * Hear one profile file land or go, for as long as the release is held.
 *
 * Its data dir may not exist yet — another worktree that has never built (the
 * dir appears with its first build), or one removed since — so while it is
 * absent the watch is of its PARENT, filtered to the dir's own name; when the
 * dir appears the file watch is armed and the tuple re-read (the profile may
 * have landed before the inner watch opened). The dir is never created here
 * for another worktree: an empty data dir would read, to every scanner of the
 * worktrees home, as a namespace that exists.
 */
async function watchProfile(
  path: string,
  notify: () => void,
): Promise<DirWatchRelease> {
  const dir = dirname(path);
  const parent = dirname(dir);
  const dirName = basename(dir);
  const file = basename(path);
  let inner: DirWatchRelease | null = null;
  let stopped = false;

  const dropInner = () => {
    inner?.();
    inner = null;
  };
  const armInner = async () => {
    if (inner !== null || !existsSync(dir)) return;
    let release: DirWatchRelease;
    try {
      release = await acquireDirWatch({
        dir,
        scope: "children",
        onChange: (events) => {
          if (events.some((e) => basename(e.path) === file)) notify();
        },
      });
    } catch (err) {
      // Removed between the check and the open: the parent watch hears it
      // come back. Any other failure is real.
      if (!existsSync(dir)) return;
      throw err;
    }
    if (stopped || inner !== null) {
      release();
      return;
    }
    inner = release;
  };

  await mkdir(parent, { recursive: true });
  const outer = await acquireDirWatch({
    dir: parent,
    scope: "children",
    onChange: async (events) => {
      if (!events.some((e) => basename(e.path) === dirName)) return;
      if (existsSync(dir)) await armInner();
      else dropInner();
      notify();
    },
  });
  await armInner();
  return () => {
    stopped = true;
    outer();
    dropInner();
  };
}

/**
 * One build run's profile, read from the worktree's build artifacts.
 *
 * `notified`, by a watch on the profile file for as long as it is read: the
 * CLI writes it ONCE, atomically (tmp + rename), as the build ends, and the
 * artifact prune may later reap it — so the watch hears the run's end (a
 * supervised build's and a hand-run one's alike, in any worktree) and is
 * silent exactly while the answer is final. That is the honest single form:
 * "immutable once terminal" would need the run's state to pick the arm per
 * tuple, and the file itself is the only record a hand-run build leaves.
 */
export const buildRunProfileServed = serveValue(buildRunProfile, {
  source: "external",
  changes: "notified",
  loader: async (params) => {
    const path = profilePathOf(params);
    if (path === null) {
      throw buildRunProfile.refuse(
        "invalid-id",
        `not a build profile: ${JSON.stringify(params)}`,
      );
    }
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      throw buildRunProfile.refuse(
        "missing",
        `No profile recorded for build ${params.buildId}.`,
      );
    }
    // Written by rename, so never partial: a file that does not parse is a
    // writer defect, and fails the read loudly.
    const profile = JSON.parse(text) as BuildProfileFile;
    return { spans: profile.spans, totalMs: profile.totalDurationMs };
  },
  // A children-scope watch of the worktree's data dir through the shared dir
  // hub, filtered to this run's profile (`watchProfile`). A malformed tuple
  // watches nothing; the loader refuses it. No trailing re-read: the runtime
  // awaits this start before the tuple's first load, so that load already runs
  // with the watch open.
  whileSubscribed: async (params, notify) => {
    const path = profilePathOf(params);
    if (path === null) return () => {};
    return watchProfile(path, notify);
  },
});
