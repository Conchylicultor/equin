import type { GitEntry, GitStatus } from "./resources";

/**
 * A checkout's status, answerable for any path below its root — what the
 * collapsed wire form leaves to the client. Every path is relative to the root
 * (`""` is the root itself), `/`-separated, with no trailing slash.
 */
export interface GitStatusIndex {
  /** The status was cut at its cap: a path it does not list is unknown, not clean. */
  readonly truncated: boolean;
  /** The path's own status: its entry, or untracked when inside an untracked dir. */
  entry(rel: string): GitEntry | null;
  /** Whether git ignores the path: a listed ignored file, or inside an ignored dir. */
  isIgnored(rel: string): boolean;
  /** Whether some path strictly below the folder `rel` changed (vs HEAD or vs main). */
  hasChangedDescendant(rel: string): boolean;
  /** Whether some path strictly below the folder `rel` changed vs main. */
  hasDescendantChangedVsMain(rel: string): boolean;
}

/** Whether `rel` is `dir` or below it. */
function isAtOrBelow(rel: string, dir: string): boolean {
  return rel === dir || rel.startsWith(`${dir}/`);
}

/** Every strict ancestor folder of `rel`, the root `""` included. */
function ancestors(rel: string): string[] {
  const out = [""];
  let cut = rel.indexOf("/");
  while (cut >= 0) {
    out.push(rel.slice(0, cut));
    cut = rel.indexOf("/", cut + 1);
  }
  return out;
}

export function indexGitStatus(status: GitStatus): GitStatusIndex {
  const ignoredFiles = new Set(status.ignoredFiles);
  const untrackedEntry: GitEntry = {
    vsHead: "untracked",
    vsMain: status.mergeBase === null ? null : "untracked",
  };
  const changedFolders = new Set<string>();
  const changedVsMainFolders = new Set<string>();
  const mark = (rel: string, vsMain: boolean) => {
    for (const a of ancestors(rel)) {
      changedFolders.add(a);
      if (vsMain) changedVsMainFolders.add(a);
    }
  };
  for (const [rel, e] of Object.entries(status.entries)) {
    mark(rel, e.vsMain !== null);
  }
  for (const dir of status.untrackedDirs) {
    // The collapsed dir stands for files below it, so its own ancestors and
    // itself hold changes.
    mark(`${dir}/*`, untrackedEntry.vsMain !== null);
  }

  return {
    truncated: status.truncated,
    entry(rel) {
      const own = status.entries[rel];
      if (own !== undefined) return own;
      return status.untrackedDirs.some((d) => isAtOrBelow(rel, d))
        ? untrackedEntry
        : null;
    },
    isIgnored(rel) {
      if (ignoredFiles.has(rel)) return true;
      return status.ignoredDirs.some((d) => isAtOrBelow(rel, d));
    },
    hasChangedDescendant(rel) {
      return changedFolders.has(rel);
    },
    hasDescendantChangedVsMain(rel) {
      return changedVsMainFolders.has(rel);
    },
  };
}

/**
 * `abs` relative to `root` (both absolute, same spelling), or `null` when it
 * is not at or below it.
 */
export function relativeTo(root: string, abs: string): string | null {
  if (abs === root) return "";
  const prefix = root === "/" ? "/" : `${root}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
}
