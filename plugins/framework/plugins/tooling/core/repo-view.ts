// The build's one view of its checkout: the snapshot taken when the build
// starts, kept up to date by the build's own writes instead of by listing the
// tree again. A writing pass (the build, `regen-generated`) used to re-take the
// whole snapshot before each phase that keys records by content (each barrel
// evaluation, the drizzle-kit verdict), only to learn the bytes of files it had
// just written itself — `git status` + `diff-files` + `ls-files` over the whole
// tree, ~0.25 s each on a quiet machine, several times per build.
//
// Exact, and checked: every answer a reader got from the view is compared, at
// the end, with a fresh snapshot (`assertAgrees`), so a write that escaped the
// view — a writer that did not note it — or a file edited under the build fails
// it by name instead of keying a record by bytes the file no longer holds.

import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  loadRepoSnapshot,
  membersWithBlobs,
  repoSnapshotOver,
} from "./repo-files";
import type { RepoSnapshot } from "./types";

export interface RepoView {
  readonly root: AppPath;
  /**
   * The snapshot as of now: the one taken when the view opened, plus every
   * write noted since — those paths alone asked of git again. The same object
   * while nothing was noted, so a memo keyed on it holds.
   */
  current(): Promise<RepoSnapshot>;
  /**
   * Files (absolute paths) this process wrote, created or removed — or a
   * directory, for a writer that cannot name its files (a child process wrote
   * them): git is asked about everything under it. Paths outside the root are
   * not the view's.
   */
  noteWrites(paths: readonly string[]): void;
  /**
   * Throws, naming each, when `fresh` (a snapshot taken now) disagrees with the
   * view on anything a reader asked of it: a member's blob, membership, a
   * directory's listing or a pattern's matches.
   */
  assertAgrees(fresh: RepoSnapshot): Promise<void>;
}

/** What readers asked of the view's snapshots. */
interface Asked {
  paths: Set<string>;
  dirs: Set<string>;
  patterns: Set<string>;
}

/**
 * `snap`, recording every question asked of it into `asked`. Not `all()` (the
 * whole membership: any file created anywhere during a build would fail a
 * check of it, a note or a research doc included) nor `read()` (the bytes are
 * read from disk, not answered by the view): a reader keys what it reads by
 * `blobOf`, `has`, `under` or `glob`.
 */
function recording(snap: RepoSnapshot, asked: Asked): RepoSnapshot {
  return {
    root: snap.root,
    all: () => snap.all(),
    has: (path) => {
      asked.paths.add(path);
      return snap.has(path);
    },
    under: (dir) => {
      asked.dirs.add(dir);
      return snap.under(dir);
    },
    glob: (pattern) => {
      asked.patterns.add(pattern);
      return snap.glob(pattern);
    },
    read: (path) => snap.read(path),
    blobOf: (path) => {
      asked.paths.add(path);
      return snap.blobOf(path);
    },
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** Open the build's view of `root`: one snapshot now, the build's writes after. */
export async function openRepoView(root: AppPath): Promise<RepoView> {
  const asked: Asked = {
    paths: new Set(),
    dirs: new Set(),
    patterns: new Set(),
  };
  let latest = await loadRepoSnapshot(root);
  let handed = recording(latest, asked);
  const pending = new Set<string>();

  // Repo-relative, or null for a path outside the root (a writer's file in
  // the user's config dir is not the view's). Absolute `/` paths: macOS.
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const relOf = (abs: string): string | null =>
    abs.startsWith(prefix) && abs.length > prefix.length
      ? abs.slice(prefix.length)
      : null;

  // One refresh at a time: a second caller waits for the first and then
  // takes what was noted meanwhile, so no answer predates a noted write and
  // no two refreshes build on the same base.
  let refreshing: Promise<RepoSnapshot> = Promise.resolve(handed);
  const current = (): Promise<RepoSnapshot> =>
    (refreshing = refreshing.then(refresh));

  const refresh = async (): Promise<RepoSnapshot> => {
    if (pending.size === 0) return handed;
    const written = [...pending];
    pending.clear();
    const now = await membersWithBlobs(root, written);
    const base = latest;
    const members = new Set(base.all());
    for (const p of written) {
      // A directory a writer named (it cannot list its files: a child
      // process wrote them) is answered whole: git's answer for it replaces
      // the view's members under it.
      for (const m of base.under(p)) if (!now.has(m)) members.delete(m);
      if (now.has(p)) members.add(p);
      else members.delete(p);
    }
    for (const m of now.keys()) members.add(m);
    latest = repoSnapshotOver(
      root,
      [...members].sort(),
      (path) => now.get(path) ?? base.blobOf(path),
    );
    handed = recording(latest, asked);
    return handed;
  };

  return {
    root,
    current,
    noteWrites(paths) {
      for (const abs of paths) {
        const rel = relOf(abs);
        if (rel !== null) pending.add(rel);
      }
    },
    async assertAgrees(fresh) {
      await current();
      const view = latest;
      const wrong: string[] = [];
      for (const p of [...asked.paths].sort()) {
        const inView = view.has(p);
        if (inView !== fresh.has(p)) {
          wrong.push(`${p}: ${inView ? "gone" : "appeared"}`);
        } else if (inView && view.blobOf(p) !== fresh.blobOf(p)) {
          wrong.push(`${p}: content changed`);
        }
      }
      for (const d of [...asked.dirs].sort()) {
        if (!sameList(view.under(d), fresh.under(d)))
          wrong.push(`${d || "."}/: files added or removed`);
      }
      for (const g of [...asked.patterns].sort()) {
        if (!sameList(view.glob(g), fresh.glob(g)))
          wrong.push(`${g}: files added or removed`);
      }
      if (wrong.length === 0) return;
      const shown = wrong.slice(0, 20);
      throw new Error(
        `[repo-view] ${wrong.length} file(s) changed under this build without the build writing them ` +
          `(a writer that did not note its write — noteRepoWrites — or an edit made during the build):\n` +
          shown.map((w) => `  - ${w}`).join("\n") +
          (wrong.length > shown.length
            ? `\n  … and ${wrong.length - shown.length} more`
            : "") +
          `\nWhat this build generated was keyed by bytes these files no longer hold: build again.`,
      );
    },
  };
}

// The view this process's writers report to: installed by the pass root that
// opened it (build, regen-generated), like the record store. One per process.
let installed: RepoView | undefined;

/** Install (or clear) the view `noteRepoWrites` reports to. */
export function installRepoView(view: RepoView | undefined): void {
  installed = view;
}

/** The installed view of `root`, if this process has one. */
export function installedRepoView(root: AppPath): RepoView | undefined {
  return installed?.root === root ? installed : undefined;
}

/**
 * Every writer of repo files a build runs calls this with what it wrote,
 * created or removed (absolute paths): the view re-asks git about exactly
 * those. With no view installed (a lone command), nothing to tell.
 */
export function noteRepoWrites(paths: readonly string[]): void {
  installed?.noteWrites(paths);
}

/**
 * The checkout's snapshot as of now: the installed view's when this process
 * has one for `root` (a step inside a build), else a fresh one.
 */
export async function repoSnapshotNow(root: AppPath): Promise<RepoSnapshot> {
  return (await installedRepoView(root)?.current()) ?? loadRepoSnapshot(root);
}
